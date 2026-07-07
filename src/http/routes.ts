import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../db/database.js";
import { config } from "../config.js";
import { BlobStore } from "../storage/blobStore.js";
import { AuthService } from "../services/auth.js";
import { RequestService } from "../services/requests.js";
import { SyncService } from "../services/sync.js";
import { sha256 } from "../lib/crypto.js";
import type { SyncOperation } from "../domain/types.js";
import { eventHub } from "../services/events.js";

const auth = new AuthService(db);
const requests = new RequestService(db);
const sync = new SyncService(db);
const blobs = new BlobStore(config.blobDir);

const deviceType = z.enum(["desktop", "mobile", "tablet", "unknown"]);
const deviceRequestSchema = z.object({
  password: z.string().min(1),
  deviceName: z.string().min(1),
  deviceType
});
const operationSchema = z.object({
  clientChangeId: z.string().min(1),
  type: z.enum(["create", "update", "delete", "rename", "move"]),
  path: z.string().min(1),
  targetPath: z.string().optional(),
  baseRevisionId: z.number().int().nullable(),
  contentHash: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  encrypted: z.boolean().optional(),
  encryptedFileKey: z.string().nullable().optional()
});

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  auth.ensureDefaultVault();

  fastify.get("/api/v1/server-info", async (request) => ({
    protocolVersion: config.protocolVersion,
    serverVersion: config.serverVersion,
    features: ["device_tokens", "sync_batches", "vault_revision", "conflicts", "decision_requests", "blob_storage"],
    maxUploadSize: config.maxUploadSize,
    maxBatchSize: config.maxBatchSize,
    websocketUrl: websocketUrl(request.headers.host ?? `${config.host}:${config.port}`)
  }));

  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const body = z.object({ password: z.string().min(1) }).parse(request.body);
    if (!auth.verifyPassword(body.password)) return reply.code(401).send({ error: "invalid_password" });
    return { ok: true, initialSetup: auth.isInitialSetupEnabled() };
  });

  fastify.post("/api/v1/devices/request", async (request, reply) => {
    const body = deviceRequestSchema.extend({ recoveryPairingCode: z.string().optional() }).parse(request.body);
    if (!auth.verifyPassword(body.password)) return reply.code(401).send({ error: "invalid_password" });

    if (auth.isInitialSetupEnabled() || (body.recoveryPairingCode && auth.consumeRecoveryPairingCode(body.recoveryPairingCode))) {
      const device = auth.createTrustedDevice(body.deviceName, body.deviceType);
      return { status: "approved", ...device };
    }

    const requestId = requests.create({
      type: "device_pairing",
      payload: {
        deviceName: body.deviceName,
        deviceType: body.deviceType,
        requestedAt: new Date().toISOString(),
        ip: request.ip
      }
    });
    return reply.code(202).send({ status: "pending", requestId });
  });

  fastify.post("/api/v1/devices/approve", async (request, reply) => {
    const body = z.object({ requestId: z.string(), deviceName: z.string(), deviceType }).parse(request.body);
    const pairing = db.prepare("SELECT id, status FROM requests WHERE id = ? AND type = 'device_pairing'").get(body.requestId) as
      | { id: string; status: string }
      | undefined;
    if (!pairing || pairing.status !== "pending") return reply.code(404).send({ error: "pending_request_not_found" });
    const device = auth.createTrustedDevice(body.deviceName, body.deviceType);
    requests.resolve(body.requestId, request.device?.id ?? null, "approved", { approvedDeviceId: device.deviceId });
    return { status: "approved", ...device };
  });

  fastify.post("/api/v1/devices/revoke", async (request) => {
    const body = z.object({ deviceId: z.string() }).parse(request.body);
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), body.deviceId);
    eventHub.broadcast({ type: "device_revoked", device_id: body.deviceId });
    return { ok: true };
  });

  fastify.get("/api/v1/devices", async () => {
    return {
      devices: db
        .prepare("SELECT id, name, type, trusted, revoked_at, last_seen_at, created_at FROM devices ORDER BY created_at DESC")
        .all()
    };
  });

  fastify.get("/api/v1/vaults", async () => ({
    vaults: db.prepare("SELECT id, name, current_revision AS currentRevision, created_at AS createdAt FROM vaults").all()
  }));

  fastify.get("/api/v1/vaults/:vaultId/changes", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    return {
      changes: db
        .prepare(
          `SELECT fr.id AS fileRevisionId, fr.vault_revision AS vaultRevision, f.path, fr.content_hash AS contentHash,
                  fr.size, fr.deleted, fr.encrypted, fr.created_at AS createdAt
             FROM file_revisions fr
             JOIN files f ON f.id = fr.file_id
            WHERE fr.vault_id = ? AND fr.vault_revision > ?
            ORDER BY fr.vault_revision ASC, fr.id ASC`
        )
        .all(params.vaultId, query.since)
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-batches", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const body = z.object({ operations: z.array(operationSchema).max(config.maxBatchSize) }).parse(request.body);
    const batchId = sync.createBatch(params.vaultId, request.device!.id, body.operations as SyncOperation[]);
    return reply.code(201).send({ batchId, status: "created" });
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-batches/:batchId/upload", async (request) => {
    const params = z.object({ batchId: z.string() }).parse(request.params);
    const parts = request.parts();
    let clientChangeId = "";
    let expectedHash = "";
    let content: Buffer | null = null;
    for await (const part of parts) {
      if (part.type === "field" && part.fieldname === "clientChangeId") clientChangeId = String(part.value);
      if (part.type === "field" && part.fieldname === "contentHash") expectedHash = String(part.value);
      if (part.type === "file" && part.fieldname === "file") content = await part.toBuffer();
    }
    if (!clientChangeId || !content) throw new Error("clientChangeId and file are required.");
    const stored = blobs.put(content);
    if (expectedHash && sha256(content) !== expectedHash) throw new Error("Uploaded content hash mismatch.");
    sync.stageBlob(params.batchId, clientChangeId, stored.hash, stored.relativePath, stored.size);
    return { ok: true, contentHash: stored.hash, size: stored.size };
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload", async (request, reply) => {
    const params = z.object({ batchId: z.string() }).parse(request.params);
    const body = z
      .object({
        clientChangeId: z.string().min(1),
        contentHash: z.string().min(1),
        size: z.number().int().nonnegative(),
        chunkSize: z.number().int().positive(),
        totalChunks: z.number().int().positive()
      })
      .parse(request.body);
    const uploadId = nanoid();
    const tempDir = path.join(config.dataDir, "staging", params.batchId, uploadId);
    fs.mkdirSync(tempDir, { recursive: true });
    db.prepare(
      `INSERT INTO staged_chunk_uploads
        (id, batch_id, client_change_id, expected_hash, expected_size, chunk_size, total_chunks, temp_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uploadId, params.batchId, body.clientChangeId, body.contentHash, body.size, body.chunkSize, body.totalChunks, tempDir, new Date().toISOString(), new Date().toISOString());
    return reply.code(201).send({ uploadId });
  });

  fastify.put("/api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload/:uploadId/chunks/:chunkIndex", async (request) => {
    const params = z.object({ uploadId: z.string(), chunkIndex: z.coerce.number().int().nonnegative() }).parse(request.params);
    const upload = db.prepare("SELECT * FROM staged_chunk_uploads WHERE id = ?").get(params.uploadId) as
      | { id: string; total_chunks: number; temp_dir: string }
      | undefined;
    if (!upload) throw new Error("Chunked upload not found.");
    if (params.chunkIndex >= upload.total_chunks) throw new Error("Chunk index out of range.");

    const content = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body as ArrayBuffer);
    const contentHash = sha256(content);
    const chunkPath = path.join(upload.temp_dir, `${params.chunkIndex}.part`);
    fs.writeFileSync(chunkPath, content);
    const inserted = db
      .prepare("INSERT OR IGNORE INTO staged_chunk_parts (upload_id, chunk_index, size, content_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(upload.id, params.chunkIndex, content.byteLength, contentHash, new Date().toISOString());
    if (inserted.changes > 0) {
      db.prepare("UPDATE staged_chunk_uploads SET received_chunks = received_chunks + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), upload.id);
    } else {
      db.prepare("UPDATE staged_chunk_parts SET size = ?, content_hash = ?, created_at = ? WHERE upload_id = ? AND chunk_index = ?").run(
        content.byteLength,
        contentHash,
        new Date().toISOString(),
        upload.id,
        params.chunkIndex
      );
    }
    return { ok: true, chunkHash: contentHash };
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-batches/:batchId/chunked-upload/:uploadId/finish", async (request) => {
    const params = z.object({ batchId: z.string(), uploadId: z.string() }).parse(request.params);
    const upload = db.prepare("SELECT * FROM staged_chunk_uploads WHERE id = ? AND batch_id = ?").get(params.uploadId, params.batchId) as
      | {
          id: string;
          batch_id: string;
          client_change_id: string;
          expected_hash: string;
          expected_size: number;
          total_chunks: number;
          received_chunks: number;
          temp_dir: string;
        }
      | undefined;
    if (!upload) throw new Error("Chunked upload not found.");
    if (upload.received_chunks !== upload.total_chunks) throw new Error("Chunked upload is incomplete.");

    const chunkPaths = Array.from({ length: upload.total_chunks }, (_, index) => path.join(upload.temp_dir, `${index}.part`));
    for (const chunkPath of chunkPaths) {
      if (!fs.existsSync(chunkPath)) throw new Error("Chunked upload is missing a part.");
    }
    const stored = blobs.putFromChunkFiles(chunkPaths);
    if (stored.hash !== upload.expected_hash) throw new Error("Chunked upload content hash mismatch.");
    if (stored.size !== upload.expected_size) throw new Error("Chunked upload size mismatch.");
    sync.stageBlob(params.batchId, upload.client_change_id, stored.hash, stored.relativePath, stored.size);
    fs.rmSync(upload.temp_dir, { recursive: true, force: true });
    return { ok: true, contentHash: stored.hash, size: stored.size };
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-batches/:batchId/commit", async (request) => {
    const params = z.object({ vaultId: z.string(), batchId: z.string() }).parse(request.params);
    return sync.commitBatch(params.vaultId, params.batchId, request.device!.id);
  });

  fastify.get("/api/v1/vaults/:vaultId/files/download", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const query = z.object({ path: z.string() }).parse(request.query);
    const revision = db
      .prepare(
        `SELECT fr.blob_path, fr.content_hash, fr.size
           FROM files f
           JOIN file_revisions fr ON fr.id = f.current_file_revision_id
          WHERE f.vault_id = ? AND f.path = ? AND f.deleted = 0`
      )
      .get(params.vaultId, query.path) as { blob_path: string; content_hash: string; size: number } | undefined;
    if (!revision) return reply.code(404).send({ error: "file_not_found" });
    reply.header("x-content-hash", revision.content_hash);
    reply.header("accept-ranges", "bytes");
    const range = request.headers.range;
    const filePath = blobs.getPath(revision.blob_path);
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d+)?$/);
      if (!match) return reply.code(416).send({ error: "invalid_range" });
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : revision.size - 1, revision.size - 1);
      if (start > end || start >= revision.size) return reply.code(416).send({ error: "range_not_satisfiable" });
      reply.code(206);
      reply.header("content-range", `bytes ${start}-${end}/${revision.size}`);
      reply.header("content-length", end - start + 1);
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }
    reply.header("content-length", revision.size);
    return reply.send(fs.createReadStream(filePath));
  });

  fastify.get("/api/v1/vaults/:vaultId/files/history", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const query = z.object({ path: z.string() }).parse(request.query);
    return {
      history: db
        .prepare(
          `SELECT fr.id, fr.vault_revision AS vaultRevision, fr.content_hash AS contentHash, fr.size,
                  fr.deleted, fr.encrypted, fr.device_id AS deviceId, fr.created_at AS createdAt
             FROM files f
             JOIN file_revisions fr ON fr.file_id = f.id
            WHERE f.vault_id = ? AND f.path = ?
            ORDER BY fr.id DESC`
        )
        .all(params.vaultId, query.path)
    };
  });

  fastify.get("/api/v1/vaults/:vaultId/requests", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    return {
      requests: db
        .prepare("SELECT * FROM requests WHERE (vault_id = ? OR vault_id IS NULL) AND status = 'pending' ORDER BY created_at ASC")
        .all(params.vaultId)
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/requests/:requestId/resolve", async (request) => {
    const params = z.object({ requestId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["approved", "rejected", "resolved"]), decision: z.unknown().optional() }).parse(request.body);
    requests.resolve(params.requestId, request.device!.id, body.status, body.decision ?? {});
    return { ok: true };
  });
}

function websocketUrl(host: string): string {
  const scheme = host.startsWith("127.") || host.startsWith("localhost") ? "ws" : "wss";
  return `${scheme}://${host}/api/v1/events`;
}
