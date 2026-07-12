import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { SyncOperation } from "../domain/types.js";
import { eventHub } from "./events.js";
import { RequestService } from "./requests.js";

type FileRow = {
  id: string;
  path: string;
  current_file_revision_id: number | null;
  current_vault_revision: number | null;
  deleted: number;
};

type BatchRow = {
  id: string;
  vault_id: string;
  device_id: string;
  status: string;
  operations_json: string;
  committed_revision: number | null;
};

type CommittedFileRevision = {
  path: string;
  fileRevisionId: number | null;
};

type CommitBatchResult = {
  status: string;
  revision?: number;
  fileRevisions?: CommittedFileRevision[];
  requestId?: string;
  conflicts?: string[];
};

export class SyncService {
  private readonly requests: RequestService;

  constructor(private readonly db: Database.Database) {
    this.requests = new RequestService(db);
  }

  now(): string {
    return new Date().toISOString();
  }

  createBatch(vaultId: string, deviceId: string, operations: SyncOperation[]): string {
    const batchId = nanoid();
    this.db
      .prepare(
        "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at) VALUES (?, ?, ?, 'created', ?, ?, ?)"
      )
      .run(batchId, vaultId, deviceId, JSON.stringify(operations), this.now(), this.now());
    return batchId;
  }

  stageBlob(batchId: string, clientChangeId: string, contentHash: string, blobPath: string, size: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO staged_blobs (batch_id, client_change_id, content_hash, blob_path, size) VALUES (?, ?, ?, ?, ?)"
      )
      .run(batchId, clientChangeId, contentHash, blobPath, size);
    this.db.prepare("UPDATE sync_batches SET status = 'uploading', updated_at = ? WHERE id = ?").run(this.now(), batchId);
  }

  commitBatch(
    vaultId: string,
    batchId: string,
    deviceId: string,
    options: { skipDangerousOperationCheck?: boolean } = {}
  ): CommitBatchResult {
    const tx = this.db.transaction(() => {
      const batch = this.db.prepare("SELECT * FROM sync_batches WHERE id = ? AND vault_id = ?").get(batchId, vaultId) as BatchRow | undefined;
      if (!batch) throw new Error("Batch not found.");
      if (batch.device_id !== deviceId) throw new Error("Batch belongs to another device.");
      const operations = JSON.parse(batch.operations_json) as SyncOperation[];
      if (batch.status === "committed") {
        return {
          status: "committed",
          revision: this.getVaultRevision(vaultId),
          fileRevisions: this.getCommittedFileRevisions(vaultId, operations, batch.committed_revision)
        };
      }

      this.db.prepare("UPDATE sync_batches SET status = 'validating', updated_at = ? WHERE id = ?").run(this.now(), batchId);
      if (!options.skipDangerousOperationCheck) {
        const dangerousRequest = this.detectDangerousOperations(vaultId, batchId, deviceId, operations);
        if (dangerousRequest) return dangerousRequest;
      }

      const conflicts: string[] = [];
      for (const operation of operations) {
        if (this.isDuplicateChange(deviceId, operation.clientChangeId)) continue;
        const current = this.getFile(vaultId, operation.path);
        const currentRevision = current?.current_file_revision_id ?? null;
        if (currentRevision !== operation.baseRevisionId) {
          conflicts.push(this.createConflict(vaultId, batchId, deviceId, operation, currentRevision));
        }
      }

      if (conflicts.length > 0) {
        this.db
          .prepare("UPDATE sync_batches SET status = 'waiting_for_decision', failure_reason = ?, updated_at = ? WHERE id = ?")
          .run("conflict", this.now(), batchId);
        return { status: "conflict", conflicts };
      }

      const revision = this.getVaultRevision(vaultId) + 1;
      for (const operation of operations) {
        if (this.isDuplicateChange(deviceId, operation.clientChangeId)) continue;
        this.applyOperation(vaultId, revision, batchId, deviceId, operation);
        this.cancelSupersededConflicts(vaultId, deviceId, operation.path, operation.clientChangeId);
        this.db
          .prepare("INSERT INTO accepted_client_changes (device_id, client_change_id, batch_id, vault_revision) VALUES (?, ?, ?, ?)")
          .run(deviceId, operation.clientChangeId, batchId, revision);
      }

      this.db.prepare("UPDATE vaults SET current_revision = ? WHERE id = ?").run(revision, vaultId);
      this.db
        .prepare("UPDATE sync_batches SET status = 'committed', committed_revision = ?, updated_at = ? WHERE id = ?")
        .run(revision, this.now(), batchId);
      eventHub.broadcast({ type: "vault_changed", vault_id: vaultId, latest_revision: revision });
      return { status: "committed", revision, fileRevisions: this.getCommittedFileRevisions(vaultId, operations, revision) };
    });
    return tx();
  }

  private detectDangerousOperations(vaultId: string, batchId: string, deviceId: string, operations: SyncOperation[]) {
    const deleteCount = operations.filter((operation) => operation.type === "delete").length;
    const emptyWrites = operations.filter((operation) => operation.type !== "delete" && operation.size === 0).length;
    const totalFiles = (this.db.prepare("SELECT COUNT(*) AS count FROM files WHERE vault_id = ? AND deleted = 0").get(vaultId) as { count: number }).count;
    const deletesTooManyFiles = deleteCount > 100 || (totalFiles > 0 && deleteCount / totalFiles > 0.2);
    if (deletesTooManyFiles || emptyWrites > 50 || operations.length > 500) {
      const requestId = this.requests.create({
        vaultId,
        type: deletesTooManyFiles ? "mass_delete_approval" : "suspicious_operation",
        createdByDeviceId: deviceId,
        payload: { batchId, deleteCount, emptyWrites, operationCount: operations.length }
      });
      this.db
        .prepare("UPDATE sync_batches SET status = 'waiting_for_decision', failure_reason = ?, updated_at = ? WHERE id = ?")
        .run("requires_user_decision", this.now(), batchId);
      return { status: "waiting_for_decision", requestId };
    }
    return null;
  }

  private applyOperation(vaultId: string, vaultRevision: number, batchId: string, deviceId: string, operation: SyncOperation): void {
    const file = this.getOrCreateFile(vaultId, operation.path);
    if (operation.type === "delete") {
      const revisionId = this.insertFileRevision(file.id, vaultId, vaultRevision, deviceId, true, null, null, 0, operation.encrypted, null, null, null, null);
      this.db
        .prepare("UPDATE files SET current_file_revision_id = ?, current_vault_revision = ?, deleted = 1, updated_at = ? WHERE id = ?")
        .run(revisionId, vaultRevision, this.now(), file.id);
      return;
    }

    const staged = this.db
      .prepare("SELECT content_hash, blob_path, size FROM staged_blobs WHERE batch_id = ? AND client_change_id = ?")
      .get(batchId, operation.clientChangeId) as { content_hash: string; blob_path: string; size: number } | undefined;
    if (!staged) throw new Error(`Missing staged blob for ${operation.clientChangeId}.`);
    if (operation.contentHash && staged.content_hash !== operation.contentHash) throw new Error(`Hash mismatch for ${operation.path}.`);
    if (operation.encrypted && !this.isValidEncryptionKey(vaultId, operation.encryptionKeyId ?? null)) {
      throw new Error(`Invalid encryption key for ${operation.path}.`);
    }

    const revisionId = this.insertFileRevision(
      file.id,
      vaultId,
      vaultRevision,
      deviceId,
      false,
      staged.content_hash,
      staged.blob_path,
      staged.size,
      operation.encrypted,
      operation.encryptedFileKey ?? null,
      operation.encryptionKeyId ?? null,
      operation.plaintextHash ?? null,
      operation.plaintextSize ?? null
    );
    this.db
      .prepare("UPDATE files SET current_file_revision_id = ?, current_vault_revision = ?, deleted = 0, updated_at = ? WHERE id = ?")
      .run(revisionId, vaultRevision, this.now(), file.id);
  }

  private insertFileRevision(
    fileId: string,
    vaultId: string,
    vaultRevision: number,
    deviceId: string,
    deleted: boolean,
    contentHash: string | null,
    blobPath: string | null,
    size: number,
    encrypted = false,
    encryptedFileKey: string | null = null,
    encryptionKeyId: string | null = null,
    plaintextHash: string | null = null,
    plaintextSize: number | null = null
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO file_revisions
          (file_id, vault_id, vault_revision, content_hash, blob_path, size, device_id, deleted, encrypted, encrypted_file_key, encryption_key_id, plaintext_hash, plaintext_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fileId,
        vaultId,
        vaultRevision,
        contentHash,
        blobPath,
        size,
        deviceId,
        deleted ? 1 : 0,
        encrypted ? 1 : 0,
        encryptedFileKey,
        encryptionKeyId,
        plaintextHash,
        plaintextSize,
        this.now()
      );
    return Number(result.lastInsertRowid);
  }

  private createConflict(vaultId: string, batchId: string, deviceId: string, operation: SyncOperation, serverRevisionId: number | null): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM conflicts
          WHERE vault_id = ? AND device_id = ? AND incoming_client_change_id = ? AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(vaultId, deviceId, operation.clientChangeId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = nanoid();
    this.db
      .prepare(
        `INSERT INTO conflicts
          (id, vault_id, file_path, base_revision_id, server_revision_id, incoming_batch_id, incoming_client_change_id, device_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, vaultId, operation.path, operation.baseRevisionId, serverRevisionId, batchId, operation.clientChangeId, deviceId, this.now());
    eventHub.broadcast({ type: "conflict_created", conflict_id: id, vault_id: vaultId, path: operation.path });
    return id;
  }

  private getCommittedFileRevisions(
    vaultId: string,
    operations: SyncOperation[],
    committedRevision: number | null
  ): CommittedFileRevision[] {
    const findRevision = this.db.prepare(
      `SELECT fr.id
         FROM file_revisions fr
         JOIN files f ON f.id = fr.file_id
        WHERE fr.vault_id = ? AND f.path = ? AND fr.vault_revision = ?
        ORDER BY fr.id DESC LIMIT 1`
    );
    return operations.map((operation) => {
      const path = operation.targetPath ?? operation.path;
      const row = committedRevision === null ? undefined : (findRevision.get(vaultId, path, committedRevision) as { id: number } | undefined);
      return { path, fileRevisionId: row?.id ?? null };
    });
  }

  private cancelSupersededConflicts(vaultId: string, deviceId: string, path: string, acceptedClientChangeId: string): void {
    const conflicts = this.db
      .prepare(
        `SELECT id, incoming_batch_id AS incomingBatchId
           FROM conflicts
          WHERE vault_id = ? AND device_id = ? AND file_path = ?
            AND incoming_client_change_id <> ? AND status = 'pending'`
      )
      .all(vaultId, deviceId, path, acceptedClientChangeId) as Array<{ id: string; incomingBatchId: string }>;
    if (conflicts.length === 0) return;

    const resolvedAt = this.now();
    const decision = JSON.stringify({ strategy: "superseded_by_accepted_change", acceptedClientChangeId });
    const resolve = this.db.prepare(
      "UPDATE conflicts SET status = 'cancelled', decision_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
    );
    for (const conflict of conflicts) {
      resolve.run(decision, resolvedAt, conflict.id);
      const pending = this.db
        .prepare("SELECT 1 FROM conflicts WHERE incoming_batch_id = ? AND status = 'pending' LIMIT 1")
        .get(conflict.incomingBatchId);
      if (!pending) {
        this.db
          .prepare("UPDATE sync_batches SET status = 'aborted', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_decision'")
          .run("superseded_by_accepted_change", resolvedAt, conflict.incomingBatchId);
      }
      eventHub.broadcast({ type: "conflict_resolved", conflict_id: conflict.id, vault_id: vaultId, status: "cancelled" });
    }
  }

  private getVaultRevision(vaultId: string): number {
    const vault = this.db.prepare("SELECT current_revision FROM vaults WHERE id = ?").get(vaultId) as { current_revision: number } | undefined;
    if (!vault) throw new Error("Vault not found.");
    return vault.current_revision;
  }

  private getFile(vaultId: string, path: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE vault_id = ? AND path = ?").get(vaultId, path) as FileRow | undefined;
  }

  private getOrCreateFile(vaultId: string, filePath: string): FileRow {
    const existing = this.getFile(vaultId, filePath);
    if (existing) return existing;
    const id = nanoid();
    this.db
      .prepare("INSERT INTO files (id, vault_id, path, deleted, updated_at) VALUES (?, ?, ?, 0, ?)")
      .run(id, vaultId, filePath, this.now());
    return this.getFile(vaultId, filePath)!;
  }

  private isValidEncryptionKey(vaultId: string, encryptionKeyId: string | null): boolean {
    if (!encryptionKeyId) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM vault_encryption_keys WHERE id = ? AND vault_id = ?").get(encryptionKeyId, vaultId));
  }

  private isDuplicateChange(deviceId: string, clientChangeId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM accepted_client_changes WHERE device_id = ? AND client_change_id = ?")
        .get(deviceId, clientChangeId)
    );
  }
}
