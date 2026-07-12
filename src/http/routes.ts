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
import { cleanupBatchStaging, cleanupStorage, getStorageUsage } from "../services/storageUsage.js";
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
const deviceNameUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120)
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
  encryptedFileKey: z.string().nullable().optional(),
  encryptionKeyId: z.string().nullable().optional(),
  plaintextHash: z.string().nullable().optional(),
  plaintextSize: z.number().int().nonnegative().nullable().optional()
});
const encryptionKeyCheckSchema = z.object({
  keyCheck: z.string().min(1)
});
const encryptRevisionSchema = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().nonnegative(),
  plaintextHash: z.string().regex(/^[a-f0-9]{64}$/i),
  plaintextSize: z.number().int().nonnegative(),
  encryptionKeyId: z.string().min(1),
  contentBase64: z.string().min(1)
});
const vaultIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const vaultCreateSchema = z.object({
  id: vaultIdSchema.optional(),
  name: z.string().trim().min(1).max(120)
});
const vaultRenameSchema = z.object({
  name: z.string().trim().min(1).max(120)
});
const localVaultInstanceIdSchema = z.string().trim().min(8).max(120);
const manifestHashSchema = z.string().trim().regex(/^[a-f0-9]{64}$/i);
const connectionAssessmentSchema = z.object({
  localVaultInstanceId: localVaultInstanceIdSchema,
  localFileCount: z.number().int().nonnegative(),
  localManifestHash: manifestHashSchema
});
const syncStateSchema = z.object({
  localVaultInstanceId: localVaultInstanceIdSchema,
  localFileCount: z.number().int().nonnegative(),
  localManifestHash: manifestHashSchema
});
const communityPluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const communityPluginSettingSchema = z.object({
  relativePath: z.string().trim().min(1).max(500).regex(/^[^/].*\.json$/i),
  contentBase64: z.string(),
  contentHash: manifestHashSchema,
  size: z.number().int().nonnegative().max(1024 * 1024)
});
const communityPluginSchema = z.object({
  id: communityPluginIdSchema,
  name: z.string().trim().max(160).nullable().optional(),
  version: z.string().trim().max(80).nullable().optional(),
  author: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  settings: z.array(communityPluginSettingSchema).max(100).optional()
});
const communityPluginSyncSchema = z.object({
  plugins: z.array(communityPluginSchema).max(500)
});

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  auth.ensureDefaultVault();

  fastify.get("/api/v1/server-info", async (request) => ({
    protocolVersion: config.protocolVersion,
    serverVersion: config.serverVersion,
    instanceId: auth.getInstanceId(),
    features: [
      "device_tokens",
      "sync_batches",
      "vault_revision",
      "conflicts",
      "decision_requests",
      "blob_storage",
      "multiple_vaults",
      "vault_connection_safety",
      "storage_usage",
      "vault_management",
      "client_side_encryption_metadata",
      "vault_encryption_key_rotation",
      "community_plugin_catalog"
    ],
    maxUploadSize: config.maxUploadSize,
    maxBatchSize: config.maxBatchSize,
    websocketUrl: websocketUrl(proxyHost(request.headers["x-forwarded-host"]) ?? request.headers.host ?? `${config.host}:${config.port}`, request.headers["x-forwarded-proto"])
  }));

  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const body = z.object({ password: z.string().min(1) }).parse(request.body);
    if (!auth.isConfigured()) return reply.code(409).send({ error: "server_not_configured" });
    if (!auth.verifyPassword(body.password)) return reply.code(401).send({ error: "invalid_password" });
    return { ok: true, initialSetup: auth.isInitialSetupEnabled() };
  });

  fastify.post("/api/v1/devices/request", async (request, reply) => {
    const body = deviceRequestSchema.extend({ recoveryPairingCode: z.string().trim().min(1).optional() }).parse(request.body);
    if (!auth.isConfigured()) return reply.code(409).send({ error: "server_not_configured" });
    if (!auth.verifyPassword(body.password)) return reply.code(401).send({ error: "invalid_password" });

    if (auth.isInitialSetupEnabled()) {
      const device = auth.createTrustedDevice(body.deviceName, body.deviceType);
      return { status: "approved", ...device };
    }

    if (body.recoveryPairingCode) {
      if (!auth.consumeRecoveryPairingCode(body.recoveryPairingCode)) {
        return reply.code(401).send({ error: "invalid_recovery_pairing_code" });
      }
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

  fastify.post("/api/v1/devices/request/:requestId/status", async (request, reply) => {
    const params = z.object({ requestId: z.string() }).parse(request.params);
    const body = z.object({ password: z.string().min(1) }).parse(request.body);
    if (!auth.isConfigured()) return reply.code(409).send({ error: "server_not_configured" });
    if (!auth.verifyPassword(body.password)) return reply.code(401).send({ error: "invalid_password" });

    const pairing = db
      .prepare("SELECT id, status, decision_json AS decisionJson FROM requests WHERE id = ? AND type = 'device_pairing'")
      .get(params.requestId) as { id: string; status: string; decisionJson: string | null } | undefined;
    if (!pairing) return reply.code(404).send({ error: "pairing_request_not_found" });
    if (pairing.status !== "approved") return { status: pairing.status };

    const decision = parseApprovedDeviceDecision(pairing.decisionJson);
    if (!decision) return reply.code(409).send({ error: "approved_device_token_not_available" });
    return { status: "approved", deviceId: decision.deviceId, deviceToken: decision.deviceToken };
  });

  fastify.post("/api/v1/devices/approve", async (request, reply) => {
    const body = z.object({ requestId: z.string(), deviceName: z.string(), deviceType }).parse(request.body);
    const pairing = db.prepare("SELECT id, status FROM requests WHERE id = ? AND type = 'device_pairing'").get(body.requestId) as
      | { id: string; status: string }
      | undefined;
    if (!pairing || pairing.status !== "pending") return reply.code(404).send({ error: "pending_request_not_found" });
    const device = auth.createTrustedDevice(body.deviceName, body.deviceType);
    requests.resolve(body.requestId, request.device?.id ?? null, "approved", {
      approvedDeviceId: device.deviceId,
      deviceToken: device.deviceToken
    });
    return { status: "approved", ...device };
  });

  fastify.post("/api/v1/devices/revoke", async (request) => {
    const body = z.object({ deviceId: z.string() }).parse(request.body);
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND deleted_at IS NULL").run(new Date().toISOString(), body.deviceId);
    eventHub.broadcast({ type: "device_revoked", device_id: body.deviceId });
    return { ok: true };
  });

  fastify.post("/api/v1/devices/restore", async (request, reply) => {
    const body = z.object({ deviceId: z.string() }).parse(request.body);
    const result = db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ? AND deleted_at IS NULL").run(body.deviceId);
    if (result.changes === 0) return reply.code(404).send({ error: "device_not_found" });
    eventHub.broadcast({ type: "device_restored", device_id: body.deviceId });
    return { ok: true };
  });

  fastify.post("/api/v1/devices/me", async (request, reply) => {
    const body = deviceNameUpdateSchema.parse(request.body);
    const result = db.prepare("UPDATE devices SET name = ? WHERE id = ? AND deleted_at IS NULL").run(body.name, request.device!.id);
    if (result.changes === 0) return reply.code(404).send({ error: "device_not_found" });
    const device = db
      .prepare(
        `SELECT d.id, d.name, d.type, d.trusted, d.revoked_at, d.last_seen_at, d.created_at,
                assigned.vault_id AS vaultId, assigned.vault_name AS vaultName
           FROM devices d
           LEFT JOIN (${deviceVaultAssignmentSql()}) assigned ON assigned.device_id = d.id
          WHERE d.id = ? AND d.deleted_at IS NULL`
      )
      .get(request.device!.id);
    eventHub.broadcast({ type: "device_updated", device_id: request.device!.id, name: body.name });
    return { ok: true, device };
  });

  fastify.post("/api/v1/devices/delete", async (request, reply) => {
    const body = z.object({ deviceId: z.string() }).parse(request.body);
    if (body.deviceId === request.device?.id) return reply.code(400).send({ error: "cannot_delete_current_device" });
    const device = db.prepare("SELECT id FROM devices WHERE id = ? AND deleted_at IS NULL").get(body.deviceId);
    if (!device) return reply.code(404).send({ error: "device_not_found" });
    const now = new Date().toISOString();
    const decisionJson = JSON.stringify({ reason: "device_deleted", deviceId: body.deviceId });
    const cleanup = db.transaction(() => {
      const cancelledConflicts = db
        .prepare("SELECT id, vault_id AS vaultId FROM conflicts WHERE device_id = ? AND status = 'pending'")
        .all(body.deviceId) as { id: string; vaultId: string }[];
      db
        .prepare("UPDATE conflicts SET status = 'cancelled', decision_json = ?, resolved_at = ? WHERE device_id = ? AND status = 'pending'")
        .run(decisionJson, now, body.deviceId);
      db
        .prepare(
          "UPDATE sync_batches SET status = 'failed', failure_reason = 'device_deleted', updated_at = ? WHERE device_id = ? AND status = 'waiting_for_decision'"
        )
        .run(now, body.deviceId);
      db.prepare("UPDATE devices SET deleted_at = ?, revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, now, body.deviceId);
      return { cancelledConflicts };
    })();
    for (const conflict of cleanup.cancelledConflicts) {
      eventHub.broadcast({ type: "conflict_resolved", conflict_id: conflict.id, vault_id: conflict.vaultId, status: "cancelled" });
    }
    eventHub.broadcast({ type: "device_deleted", device_id: body.deviceId });
    return { ok: true, cancelledConflicts: cleanup.cancelledConflicts.length };
  });

  fastify.get("/api/v1/devices", async () => {
    return {
      devices: db
        .prepare(
          `SELECT d.id, d.name, d.type, d.trusted, d.revoked_at, d.last_seen_at, d.created_at,
                  assigned.vault_id AS vaultId, assigned.vault_name AS vaultName
             FROM devices d
             LEFT JOIN (${deviceVaultAssignmentSql()}) assigned ON assigned.device_id = d.id
            WHERE d.deleted_at IS NULL
            ORDER BY d.created_at DESC`
        )
        .all()
    };
  });

  fastify.get("/api/v1/vaults/:vaultId/conflicts", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    return {
      conflicts: db
        .prepare(
          `SELECT c.id, c.file_path AS filePath, c.base_revision_id AS baseRevisionId,
                  c.server_revision_id AS serverRevisionId, c.incoming_batch_id AS incomingBatchId,
                  c.incoming_client_change_id AS incomingClientChangeId, c.device_id AS deviceId,
                  c.status, c.created_at AS createdAt, d.name AS deviceName, d.type AS deviceType
             FROM conflicts c
             LEFT JOIN devices d ON d.id = c.device_id
            WHERE c.vault_id = ? AND c.status = 'pending'
            ORDER BY c.created_at DESC`
        )
        .all(params.vaultId)
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/conflicts/:conflictId/resolve", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), conflictId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["resolved", "cancelled"]), decision: z.unknown().optional() }).parse(request.body);
    const result = db
      .prepare(
        "UPDATE conflicts SET status = ?, decision_json = ?, resolved_at = ? WHERE id = ? AND vault_id = ? AND status = 'pending'"
      )
      .run(body.status, JSON.stringify(body.decision ?? {}), new Date().toISOString(), params.conflictId, params.vaultId);
    if (result.changes === 0) return reply.code(404).send({ error: "pending_conflict_not_found" });
    eventHub.broadcast({ type: "conflict_resolved", conflict_id: params.conflictId, vault_id: params.vaultId, status: body.status });
    return { ok: true };
  });

  fastify.get("/api/v1/vaults", async () => ({
    vaults: listVaultsWithEncryptionKeys()
  }));

  fastify.post("/api/v1/vaults", async (request, reply) => {
    const body = vaultCreateSchema.parse(request.body);
    const id = body.id ?? vaultIdFromName(body.name);
    const existing = db.prepare("SELECT id FROM vaults WHERE id = ?").get(id);
    if (existing) return reply.code(409).send({ error: "vault_already_exists" });
    db.prepare("INSERT INTO vaults (id, name, current_revision, created_at) VALUES (?, ?, 0, ?)").run(id, body.name, new Date().toISOString());
    return reply.code(201).send(vaultWithEncryptionKey(id));
  });

  fastify.post("/api/v1/vaults/:vaultId/rename", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const body = vaultRenameSchema.parse(request.body);
    const result = db.prepare("UPDATE vaults SET name = ? WHERE id = ?").run(body.name, params.vaultId);
    if (result.changes === 0) return reply.code(404).send({ error: "vault_not_found" });
    eventHub.broadcast({ type: "vault_updated", vault_id: params.vaultId, name: body.name });
    return vaultWithEncryptionKey(params.vaultId);
  });

  fastify.get("/api/v1/vaults/:vaultId/encryption-keys", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    if (!vaultExists(params.vaultId)) return reply.code(404).send({ error: "vault_not_found" });
    const keys = db
      .prepare(
        `SELECT id, key_check AS keyCheck, active, created_at AS createdAt, retired_at AS retiredAt
           FROM vault_encryption_keys
          WHERE vault_id = ?
          ORDER BY created_at DESC, id DESC`
      )
      .all(params.vaultId) as Array<{ id: string; keyCheck: string; active: number; createdAt: string; retiredAt: string | null }>;
    return {
      active: keys.find((key) => key.active) ?? null,
      keys
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/encryption-keys", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const body = encryptionKeyCheckSchema.parse(request.body);
    if (!vaultExists(params.vaultId)) return reply.code(404).send({ error: "vault_not_found" });
    const now = new Date().toISOString();
    const key = db.transaction(() => {
      const active = db
        .prepare("SELECT id, key_check AS keyCheck FROM vault_encryption_keys WHERE vault_id = ? AND active = 1")
        .get(params.vaultId) as { id: string; keyCheck: string } | undefined;
      if (active?.keyCheck === body.keyCheck) return active;
      db.prepare("UPDATE vault_encryption_keys SET active = 0, retired_at = ? WHERE vault_id = ? AND active = 1").run(now, params.vaultId);
      const id = nanoid();
      db.prepare("INSERT INTO vault_encryption_keys (id, vault_id, key_check, active, created_at) VALUES (?, ?, ?, 1, ?)").run(
        id,
        params.vaultId,
        body.keyCheck,
        now
      );
      const vault = db.prepare("SELECT name FROM vaults WHERE id = ?").get(params.vaultId) as { name: string };
      eventHub.broadcast({ type: "vault_updated", vault_id: params.vaultId, name: vault.name });
      return { id, keyCheck: body.keyCheck };
    })();
    return reply.code(201).send({ id: key.id, keyCheck: key.keyCheck, active: true, createdAt: now });
  });

  fastify.post("/api/v1/vaults/:vaultId/delete", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const vault = db.prepare("SELECT id FROM vaults WHERE id = ?").get(params.vaultId);
    if (!vault) return reply.code(404).send({ error: "vault_not_found" });
    deleteVault(params.vaultId);
    eventHub.broadcast({ type: "vault_deleted", vault_id: params.vaultId });
    return { ok: true };
  });

  fastify.get("/api/v1/vaults/:vaultId/community-plugins", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    if (!vaultExists(params.vaultId)) return reply.code(404).send({ error: "vault_not_found" });
    return { plugins: listCommunityPlugins(params.vaultId) };
  });

  fastify.put("/api/v1/vaults/:vaultId/community-plugins", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    if (!vaultExists(params.vaultId)) return reply.code(404).send({ error: "vault_not_found" });
    const body = communityPluginSyncSchema.parse(request.body);
    upsertCommunityPlugins(params.vaultId, request.device!.id, body.plugins);
    return { ok: true, plugins: listCommunityPlugins(params.vaultId) };
  });

  fastify.post("/api/v1/vaults/:vaultId/connection-assessment", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const body = connectionAssessmentSchema.parse(request.body);
    const vault = db.prepare("SELECT current_revision AS currentRevision FROM vaults WHERE id = ?").get(params.vaultId) as
      | { currentRevision: number }
      | undefined;
    if (!vault) return reply.code(404).send({ error: "vault_not_found" });

    const remoteManifest = getVaultManifest(params.vaultId);
    const previousConnection = getVaultConnection(params.vaultId, request.device!.id, body.localVaultInstanceId);
    const assessment = assessConnection({
      localManifestHash: body.localManifestHash.toLowerCase(),
      localFileCount: body.localFileCount,
      remoteRevision: vault.currentRevision,
      remoteManifest,
      previousConnection
    });

    return {
      remoteFileCount: remoteManifest.fileCount,
      remoteRevision: vault.currentRevision,
      remoteManifestHash: remoteManifest.manifestHash,
      previousConnection,
      riskLevel: assessment.riskLevel,
      reasons: assessment.reasons
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/sync-state", async (request, reply) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const body = syncStateSchema.parse(request.body);
    const vault = db.prepare("SELECT current_revision AS currentRevision FROM vaults WHERE id = ?").get(params.vaultId) as
      | { currentRevision: number }
      | undefined;
    if (!vault) return reply.code(404).send({ error: "vault_not_found" });
    db
      .prepare(
        `INSERT INTO vault_connections
          (vault_id, device_id, local_vault_instance_id, last_synced_at, last_seen_revision, last_manifest_hash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault_id, device_id, local_vault_instance_id)
         DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           last_seen_revision = excluded.last_seen_revision,
           last_manifest_hash = excluded.last_manifest_hash`
      )
      .run(params.vaultId, request.device!.id, body.localVaultInstanceId, new Date().toISOString(), vault.currentRevision, body.localManifestHash.toLowerCase());
    return { ok: true, revision: vault.currentRevision };
  });

  fastify.get("/api/v1/storage/usage", async () => getStorageUsage(db));

  fastify.post("/api/v1/storage/cleanup", async (request) => {
    const body = z.object({ targets: z.array(z.enum(["stale_staging", "npm_cache"])).min(1) }).parse(request.body);
    return cleanupStorage(db, body.targets);
  });

  fastify.get("/api/v1/vaults/:vaultId/changes", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    const query = z.object({ since: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    return {
      changes: db
        .prepare(
          `SELECT fr.id AS fileRevisionId, fr.vault_revision AS vaultRevision, f.path, fr.content_hash AS contentHash,
                  fr.size, fr.plaintext_hash AS plaintextHash, fr.plaintext_size AS plaintextSize,
                  fr.deleted, fr.encrypted, fr.encryption_key_id AS encryptionKeyId, fr.device_id AS deviceId, fr.created_at AS createdAt
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

  fastify.post("/api/v1/vaults/:vaultId/sync-batches/:batchId/commit", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), batchId: z.string() }).parse(request.params);
    let result: ReturnType<SyncService["commitBatch"]>;
    try {
      result = sync.commitBatch(params.vaultId, params.batchId, request.device!.id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid encryption key for ")) {
        return reply.code(400).send({ error: "invalid_encryption_key", message: error.message });
      }
      throw error;
    }
    if (result.status === "committed") cleanupBatchStaging(params.batchId);
    return result;
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
                  fr.plaintext_hash AS plaintextHash, fr.plaintext_size AS plaintextSize,
                  fr.deleted, fr.encrypted, fr.encryption_key_id AS encryptionKeyId, fr.device_id AS deviceId, fr.created_at AS createdAt
             FROM files f
             JOIN file_revisions fr ON fr.file_id = f.id
            WHERE f.vault_id = ? AND f.path = ?
            ORDER BY fr.id DESC`
        )
        .all(params.vaultId, query.path)
    };
  });

  fastify.get("/api/v1/vaults/:vaultId/files/revisions/:revisionId/download", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), revisionId: z.coerce.number().int().positive() }).parse(request.params);
    const revision = getFileRevision(params.vaultId, params.revisionId);
    if (!revision || revision.deleted || !revision.blob_path) return reply.code(404).send({ error: "revision_not_downloadable" });
    reply.header("x-content-hash", revision.content_hash ?? "");
    reply.header("content-length", revision.size);
    return reply.send(fs.createReadStream(blobs.getPath(revision.blob_path)));
  });

  fastify.post("/api/v1/vaults/:vaultId/files/revisions/:revisionId/restore", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), revisionId: z.coerce.number().int().positive() }).parse(request.params);
    const restored = restoreRevision(params.vaultId, params.revisionId, request.device!.id);
    if (!restored) return reply.code(404).send({ error: "revision_not_found" });
    return restored;
  });

  fastify.post("/api/v1/vaults/:vaultId/files/revisions/:revisionId/encrypt", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), revisionId: z.coerce.number().int().positive() }).parse(request.params);
    const body = encryptRevisionSchema.parse(request.body);
    const revision = getFileRevision(params.vaultId, params.revisionId);
    if (!revision || revision.deleted || !revision.blob_path) return reply.code(404).send({ error: "revision_not_downloadable" });
    if (revision.encrypted) return reply.code(409).send({ error: "revision_already_encrypted" });
    if (revision.content_hash !== body.plaintextHash || revision.size !== body.plaintextSize) return reply.code(409).send({ error: "revision_plaintext_mismatch" });
    const key = db
      .prepare("SELECT id FROM vault_encryption_keys WHERE id = ? AND vault_id = ?")
      .get(body.encryptionKeyId, params.vaultId);
    if (!key) return reply.code(400).send({ error: "encryption_key_not_found" });
    const content = Buffer.from(body.contentBase64, "base64");
    const stored = blobs.put(content);
    if (stored.hash !== body.contentHash || stored.size !== body.size) return reply.code(400).send({ error: "encrypted_content_mismatch" });
    db.prepare(
      `UPDATE file_revisions
          SET content_hash = ?, blob_path = ?, size = ?, encrypted = 1, encryption_key_id = ?, plaintext_hash = ?, plaintext_size = ?
        WHERE id = ? AND vault_id = ? AND encrypted = 0`
    ).run(stored.hash, stored.relativePath, stored.size, body.encryptionKeyId, body.plaintextHash, body.plaintextSize, params.revisionId, params.vaultId);
    return { ok: true, contentHash: stored.hash, size: stored.size, encryptionKeyId: body.encryptionKeyId };
  });

  fastify.get("/api/v1/vaults/:vaultId/requests", async (request) => {
    const params = z.object({ vaultId: z.string() }).parse(request.params);
    return {
      requests: db
        .prepare("SELECT * FROM requests WHERE (vault_id = ? OR vault_id IS NULL) AND status = 'pending' ORDER BY created_at ASC")
        .all(params.vaultId)
    };
  });

  fastify.post("/api/v1/vaults/:vaultId/requests/:requestId/resolve", async (request, reply) => {
    const params = z.object({ vaultId: z.string(), requestId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["approved", "rejected", "resolved"]), decision: z.unknown().optional() }).parse(request.body);
    const pending = db.prepare("SELECT * FROM requests WHERE id = ? AND (vault_id = ? OR vault_id IS NULL) AND status = 'pending'").get(
      params.requestId,
      params.vaultId
    ) as { id: string; type: string; created_by_device_id: string | null; payload_json: string } | undefined;
    if (!pending) return reply.code(404).send({ error: "pending_request_not_found" });
    requests.resolve(params.requestId, request.device!.id, body.status, body.decision ?? {});
    if (body.status === "approved" && (pending.type === "mass_delete_approval" || pending.type === "suspicious_operation")) {
      const payload = JSON.parse(pending.payload_json) as { batchId?: unknown };
      if (typeof payload.batchId === "string" && pending.created_by_device_id) {
        const result = sync.commitBatch(params.vaultId, payload.batchId, pending.created_by_device_id, {
          skipDangerousOperationCheck: true
        });
        if (result.status === "committed") cleanupBatchStaging(payload.batchId);
        return { ok: true, batch: result };
      }
    }
    return { ok: true };
  });
}

function deviceVaultAssignmentSql(): string {
  return `
    SELECT ranked.device_id, ranked.vault_id, ranked.vault_name
      FROM (
        SELECT vc.device_id, vc.vault_id, v.name AS vault_name,
               ROW_NUMBER() OVER (
                 PARTITION BY vc.device_id
                 ORDER BY vc.last_synced_at DESC, vc.vault_id ASC
               ) AS rank
          FROM vault_connections vc
          JOIN vaults v ON v.id = vc.vault_id
      ) ranked
     WHERE ranked.rank = 1
  `;
}

function deleteVault(vaultId: string): void {
  const tx = db.transaction(() => {
    const batches = db.prepare("SELECT id FROM sync_batches WHERE vault_id = ?").all(vaultId) as { id: string }[];
    for (const batch of batches) {
      const uploads = db.prepare("SELECT id, temp_dir FROM staged_chunk_uploads WHERE batch_id = ?").all(batch.id) as { id: string; temp_dir: string }[];
      for (const upload of uploads) {
        db.prepare("DELETE FROM staged_chunk_parts WHERE upload_id = ?").run(upload.id);
        fs.rmSync(upload.temp_dir, { recursive: true, force: true });
      }
      db.prepare("DELETE FROM staged_chunk_uploads WHERE batch_id = ?").run(batch.id);
      db.prepare("DELETE FROM staged_blobs WHERE batch_id = ?").run(batch.id);
    }
    db.prepare("DELETE FROM conflicts WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM request_log WHERE request_id IN (SELECT id FROM requests WHERE vault_id = ?)").run(vaultId);
    db.prepare("DELETE FROM requests WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM vault_connections WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM file_revisions WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM files WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM sync_batches WHERE vault_id = ?").run(vaultId);
    db.prepare("DELETE FROM vaults WHERE id = ?").run(vaultId);
  });
  tx();
}

function websocketUrl(host: string, forwardedProto: string | string[] | undefined): string {
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const scheme = proto === "https" ? "wss" : host.startsWith("127.") || host.startsWith("localhost") ? "ws" : "wss";
  return `${scheme}://${host}/api/v1/events`;
}

function proxyHost(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getFileRevision(vaultId: string, revisionId: number):
  | {
      id: number;
      file_id: string;
      path: string;
      vault_id: string;
      content_hash: string | null;
      blob_path: string | null;
      size: number;
      deleted: number;
      encrypted: number;
      encrypted_file_key: string | null;
      encryption_key_id: string | null;
      plaintext_hash: string | null;
      plaintext_size: number | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT fr.id, fr.file_id, f.path, fr.vault_id, fr.content_hash, fr.blob_path, fr.size, fr.deleted,
              fr.encrypted, fr.encrypted_file_key, fr.encryption_key_id, fr.plaintext_hash, fr.plaintext_size
         FROM file_revisions fr
         JOIN files f ON f.id = fr.file_id
        WHERE fr.vault_id = ? AND fr.id = ?`
    )
    .get(vaultId, revisionId) as
    | {
        id: number;
        file_id: string;
        path: string;
        vault_id: string;
        content_hash: string | null;
        blob_path: string | null;
        size: number;
        deleted: number;
        encrypted: number;
        encrypted_file_key: string | null;
        encryption_key_id: string | null;
        plaintext_hash: string | null;
        plaintext_size: number | null;
      }
    | undefined;
}

function restoreRevision(vaultId: string, revisionId: number, deviceId: string): { ok: true; revision: number; path: string } | null {
  const tx = db.transaction(() => {
    const revision = getFileRevision(vaultId, revisionId);
    if (!revision) return null;
    const vault = db.prepare("SELECT current_revision FROM vaults WHERE id = ?").get(vaultId) as { current_revision: number } | undefined;
    if (!vault) return null;
    const vaultRevision = vault.current_revision + 1;
    const inserted = db
      .prepare(
        `INSERT INTO file_revisions
          (file_id, vault_id, vault_revision, content_hash, blob_path, size, device_id, deleted, encrypted, encrypted_file_key, encryption_key_id, plaintext_hash, plaintext_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revision.file_id,
        vaultId,
        vaultRevision,
        revision.content_hash,
        revision.blob_path,
        revision.size,
        deviceId,
        revision.deleted ? 1 : 0,
        revision.encrypted ? 1 : 0,
        revision.encrypted_file_key,
        revision.encryption_key_id,
        revision.plaintext_hash,
        revision.plaintext_size,
        new Date().toISOString()
      );
    db.prepare("UPDATE files SET current_file_revision_id = ?, current_vault_revision = ?, deleted = ?, updated_at = ? WHERE id = ?").run(
      Number(inserted.lastInsertRowid),
      vaultRevision,
      revision.deleted ? 1 : 0,
      new Date().toISOString(),
      revision.file_id
    );
    db.prepare("UPDATE vaults SET current_revision = ? WHERE id = ?").run(vaultRevision, vaultId);
    eventHub.broadcast({ type: "vault_changed", vault_id: vaultId, latest_revision: vaultRevision });
    return { ok: true as const, revision: vaultRevision, path: revision.path };
  });
  return tx();
}

function vaultExists(vaultId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM vaults WHERE id = ?").get(vaultId));
}

function listVaultsWithEncryptionKeys(): unknown[] {
  return db
    .prepare(
      `SELECT v.id, v.name, v.current_revision AS currentRevision, v.created_at AS createdAt,
              k.id AS encryptionKeyId, k.key_check AS encryptionKeyCheck
         FROM vaults v
         LEFT JOIN vault_encryption_keys k ON k.vault_id = v.id AND k.active = 1
        ORDER BY v.name COLLATE NOCASE, v.id`
    )
    .all();
}

function vaultWithEncryptionKey(vaultId: string): unknown {
  return db
    .prepare(
      `SELECT v.id, v.name, v.current_revision AS currentRevision, v.created_at AS createdAt,
              k.id AS encryptionKeyId, k.key_check AS encryptionKeyCheck
         FROM vaults v
         LEFT JOIN vault_encryption_keys k ON k.vault_id = v.id AND k.active = 1
        WHERE v.id = ?`
    )
    .get(vaultId);
}

function parseApprovedDeviceDecision(decisionJson: string | null): { deviceId: string; deviceToken: string } | null {
  if (!decisionJson) return null;
  try {
    const decision = JSON.parse(decisionJson) as { approvedDeviceId?: unknown; deviceToken?: unknown };
    if (typeof decision.approvedDeviceId !== "string" || typeof decision.deviceToken !== "string") return null;
    return { deviceId: decision.approvedDeviceId, deviceToken: decision.deviceToken };
  } catch {
    return null;
  }
}

function vaultIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return vaultIdSchema.safeParse(slug).success ? slug : `vault-${nanoid(8)}`;
}

type CommunityPluginInput = z.infer<typeof communityPluginSchema>;

function listCommunityPlugins(vaultId: string): unknown[] {
  const plugins = db
    .prepare(
      `SELECT plugin_id AS id, name, version, author, description,
              source_device_id AS sourceDeviceId, first_seen_at AS firstSeenAt, updated_at AS updatedAt
         FROM vault_community_plugins
        WHERE vault_id = ?
        ORDER BY COALESCE(name, plugin_id) COLLATE NOCASE, plugin_id COLLATE NOCASE`
    )
    .all(vaultId) as Array<{ id: string }>;
  const settings = db
    .prepare(
      `SELECT plugin_id AS pluginId, relative_path AS relativePath, content_base64 AS contentBase64,
              content_hash AS contentHash, size, source_device_id AS sourceDeviceId, updated_at AS updatedAt
         FROM vault_community_plugin_settings
        WHERE vault_id = ?
        ORDER BY plugin_id COLLATE NOCASE, relative_path COLLATE NOCASE`
    )
    .all(vaultId) as Array<{ pluginId: string }>;
  const settingsByPlugin = new Map<string, unknown[]>();
  for (const setting of settings) {
    const list = settingsByPlugin.get(setting.pluginId) ?? [];
    list.push(setting);
    settingsByPlugin.set(setting.pluginId, list);
  }
  return plugins.map((plugin) => ({ ...plugin, settings: settingsByPlugin.get(plugin.id) ?? [] }));
}

function upsertCommunityPlugins(vaultId: string, deviceId: string, plugins: CommunityPluginInput[]): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const plugin of plugins) {
      db.prepare(
        `INSERT INTO vault_community_plugins
          (vault_id, plugin_id, name, version, author, description, source_device_id, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault_id, plugin_id)
         DO UPDATE SET
           name = COALESCE(excluded.name, vault_community_plugins.name),
           version = COALESCE(excluded.version, vault_community_plugins.version),
           author = COALESCE(excluded.author, vault_community_plugins.author),
           description = COALESCE(excluded.description, vault_community_plugins.description),
           source_device_id = excluded.source_device_id,
           updated_at = excluded.updated_at`
      ).run(
        vaultId,
        plugin.id,
        plugin.name ?? null,
        plugin.version ?? null,
        plugin.author ?? null,
        plugin.description ?? null,
        deviceId,
        now,
        now
      );
      for (const setting of plugin.settings ?? []) {
        db.prepare(
          `INSERT INTO vault_community_plugin_settings
            (vault_id, plugin_id, relative_path, content_base64, content_hash, size, source_device_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(vault_id, plugin_id, relative_path)
           DO UPDATE SET
             content_base64 = excluded.content_base64,
             content_hash = excluded.content_hash,
             size = excluded.size,
             source_device_id = excluded.source_device_id,
             updated_at = excluded.updated_at`
        ).run(vaultId, plugin.id, setting.relativePath, setting.contentBase64, setting.contentHash.toLowerCase(), setting.size, deviceId, now);
      }
    }
  });
  tx();
}

type VaultManifest = {
  fileCount: number;
  manifestHash: string;
};

type VaultConnection = {
  localVaultInstanceId: string;
  lastSyncedAt: string;
  lastSeenRevision: number;
  lastManifestHash: string;
} | null;

type RiskLevel = "empty" | "high" | "medium" | "very_low";

function getVaultManifest(vaultId: string): VaultManifest {
  const rows = db
    .prepare(
      `SELECT f.path, fr.content_hash AS contentHash, fr.size,
              fr.encrypted, fr.plaintext_hash AS plaintextHash, fr.plaintext_size AS plaintextSize
         FROM files f
         JOIN file_revisions fr ON fr.id = f.current_file_revision_id
        WHERE f.vault_id = ? AND f.deleted = 0
        ORDER BY f.path ASC`
    )
    .all(vaultId) as Array<{ path: string; contentHash: string | null; size: number; encrypted: number; plaintextHash: string | null; plaintextSize: number | null }>;
  return {
    fileCount: rows.length,
    manifestHash: sha256(
      rows
        .map((row) => `${row.path}\0${row.encrypted ? row.plaintextHash ?? row.contentHash ?? "" : row.contentHash ?? ""}\0${row.encrypted ? row.plaintextSize ?? row.size : row.size}`)
        .join("\n")
    )
  };
}

function getVaultConnection(vaultId: string, deviceId: string, localVaultInstanceId: string): VaultConnection {
  const row = db
    .prepare(
      `SELECT local_vault_instance_id AS localVaultInstanceId,
              last_synced_at AS lastSyncedAt,
              last_seen_revision AS lastSeenRevision,
              last_manifest_hash AS lastManifestHash
         FROM vault_connections
        WHERE vault_id = ? AND device_id = ? AND local_vault_instance_id = ?`
    )
    .get(vaultId, deviceId, localVaultInstanceId) as VaultConnection | undefined;
  return row ?? null;
}

function assessConnection(input: {
  localManifestHash: string;
  localFileCount: number;
  remoteRevision: number;
  remoteManifest: VaultManifest;
  previousConnection: VaultConnection;
}): { riskLevel: RiskLevel; reasons: string[] } {
  if (input.remoteManifest.fileCount === 0) {
    return { riskLevel: "empty", reasons: ["Remote vault is empty."] };
  }
  const reasons: string[] = [];
  if (input.localManifestHash === input.remoteManifest.manifestHash) {
    reasons.push("Local and remote manifests match.");
    return { riskLevel: "high", reasons };
  }
  if (input.previousConnection) {
    const lastSyncMs = Date.parse(input.previousConnection.lastSyncedAt);
    const fresh = Number.isFinite(lastSyncMs) && Date.now() - lastSyncMs <= 24 * 60 * 60 * 1000;
    if (fresh && input.previousConnection.lastSeenRevision === input.remoteRevision) {
      reasons.push("This local vault synced with this remote vault in the last 24 hours at the current remote revision.");
      return { riskLevel: "high", reasons };
    }
    reasons.push(
      fresh
        ? "This local vault synced with this remote vault recently, but the remote revision changed."
        : "This local vault synced with this remote vault before, but not in the last 24 hours."
    );
    reasons.push(`Local files: ${input.localFileCount}; remote files: ${input.remoteManifest.fileCount}.`);
    return { riskLevel: "medium", reasons };
  }
  return {
    riskLevel: "very_low",
    reasons: [
      "No previous connection was found for this local vault and remote vault.",
      `Local files: ${input.localFileCount}; remote files: ${input.remoteManifest.fileCount}.`
    ]
  };
}
