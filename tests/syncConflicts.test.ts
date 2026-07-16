import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db/schema.js";
import { SyncService } from "../src/services/sync.js";
import type { SyncOperation } from "../src/domain/types.js";

function setup(): { db: Database.Database; service: SyncService } {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO devices (id, name, type, token_hash, created_at) VALUES ('d1', 'Device', 'desktop', 'token', 'now')").run();
  db.prepare("INSERT INTO vaults (id, name, current_revision, created_at) VALUES ('v1', 'Vault', 7, 'now')").run();
  return { db, service: new SyncService(db) };
}

const operation: SyncOperation = {
  clientChangeId: "change-1",
  type: "update",
  path: "note.md",
  baseRevisionId: 41
};

test("a committed batch returns file revision ids instead of only the vault revision", () => {
  const { db, service } = setup();
  try {
    db.prepare(
      "INSERT INTO files (id, vault_id, path, current_file_revision_id, current_vault_revision, updated_at) VALUES ('f1', 'v1', 'note.md', 42, 7, 'now')"
    ).run();
    db.prepare(
      `INSERT INTO file_revisions
        (id, file_id, vault_id, vault_revision, size, device_id, created_at)
       VALUES (42, 'f1', 'v1', 7, 0, 'd1', 'now')`
    ).run();
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at, committed_revision) VALUES ('b1', 'v1', 'd1', 'committed', ?, 'now', 'now', 7)"
    ).run(JSON.stringify([operation]));

    assert.deepEqual(service.commitBatch("v1", "b1", "d1"), {
      status: "committed",
      revision: 7,
      fileRevisions: [{ path: "note.md", fileRevisionId: 42 }]
    });
  } finally {
    db.close();
  }
});

test("an all-duplicate batch does not increment the vault revision and returns the current file revision", () => {
  const { db, service } = setup();
  try {
    db.prepare(
      "INSERT INTO files (id, vault_id, path, current_file_revision_id, current_vault_revision, updated_at) VALUES ('f1', 'v1', 'note.md', 42, 7, 'now')"
    ).run();
    db.prepare(
      `INSERT INTO file_revisions
        (id, file_id, vault_id, vault_revision, size, device_id, created_at)
       VALUES (42, 'f1', 'v1', 7, 0, 'd1', 'now')`
    ).run();
    db.prepare(
      "INSERT INTO accepted_client_changes (device_id, client_change_id, batch_id, vault_revision) VALUES ('d1', 'change-1', 'original', 7)"
    ).run();
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at) VALUES ('retry', 'v1', 'd1', 'created', ?, 'now', 'now')"
    ).run(JSON.stringify([operation]));

    assert.deepEqual(service.commitBatch("v1", "retry", "d1"), {
      status: "committed",
      revision: 7,
      fileRevisions: [{ path: "note.md", fileRevisionId: 42 }]
    });
    assert.deepEqual(db.prepare("SELECT current_revision AS revision FROM vaults WHERE id = 'v1'").get(), { revision: 7 });
    assert.deepEqual(db.prepare("SELECT status, committed_revision AS revision FROM sync_batches WHERE id = 'retry'").get(), {
      status: "committed",
      revision: 7
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM file_revisions").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test("committed batch revision lookup falls back to the file's current revision", () => {
  const { db, service } = setup();
  try {
    db.prepare(
      "INSERT INTO files (id, vault_id, path, current_file_revision_id, current_vault_revision, updated_at) VALUES ('f1', 'v1', 'note.md', 42, 7, 'now')"
    ).run();
    db.prepare(
      `INSERT INTO file_revisions
        (id, file_id, vault_id, vault_revision, size, device_id, created_at)
       VALUES (42, 'f1', 'v1', 7, 0, 'd1', 'now')`
    ).run();
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at, committed_revision) VALUES ('b1', 'v1', 'd1', 'committed', ?, 'now', 'now', 6)"
    ).run(JSON.stringify([operation]));

    assert.deepEqual(service.commitBatch("v1", "b1", "d1").fileRevisions, [{ path: "note.md", fileRevisionId: 42 }]);
  } finally {
    db.close();
  }
});

test("retries reuse one pending conflict and a later accepted change cancels it", () => {
  const { db, service } = setup();
  try {
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at) VALUES ('b1', 'v1', 'd1', 'waiting_for_decision', ?, 'now', 'now')"
    ).run(JSON.stringify([operation]));

    const internals = service as unknown as {
      createConflict(vaultId: string, batchId: string, deviceId: string, operation: SyncOperation, serverRevisionId: number | null): string;
      cancelSupersededConflicts(vaultId: string, deviceId: string, path: string, acceptedClientChangeId: string): void;
    };
    const first = internals.createConflict("v1", "b1", "d1", operation, 42);
    const retry = internals.createConflict("v1", "b1", "d1", operation, 42);

    assert.equal(retry, first);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM conflicts").get() as { count: number }).count, 1);

    internals.cancelSupersededConflicts("v1", "d1", "note.md", "change-2");
    assert.deepEqual(db.prepare("SELECT status, decision_json AS decisionJson FROM conflicts WHERE id = ?").get(first), {
      status: "cancelled",
      decisionJson: JSON.stringify({ strategy: "superseded_by_accepted_change", acceptedClientChangeId: "change-2" })
    });
    assert.deepEqual(db.prepare("SELECT status, failure_reason AS failureReason FROM sync_batches WHERE id = 'b1'").get(), {
      status: "aborted",
      failureReason: "superseded_by_accepted_change"
    });
  } finally {
    db.close();
  }
});

test("resolving the last pending conflict aborts its waiting batch", () => {
  const { db, service } = setup();
  try {
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at) VALUES ('b1', 'v1', 'd1', 'waiting_for_decision', ?, 'now', 'now')"
    ).run(JSON.stringify([operation]));
    const conflictId = (service as unknown as {
      createConflict(vaultId: string, batchId: string, deviceId: string, operation: SyncOperation, serverRevisionId: number | null): string;
    }).createConflict("v1", "b1", "d1", operation, 42);

    assert.equal(service.resolveConflict("v1", conflictId, "resolved", { strategy: "auto_merge" }), true);
    assert.deepEqual(db.prepare("SELECT status, failure_reason AS failureReason FROM sync_batches WHERE id = 'b1'").get(), {
      status: "aborted",
      failureReason: "conflict_resolved"
    });
    assert.deepEqual(db.prepare("SELECT status, decision_json AS decisionJson FROM conflicts WHERE id = ?").get(conflictId), {
      status: "resolved",
      decisionJson: JSON.stringify({ strategy: "auto_merge" })
    });
    assert.equal(service.resolveConflict("v1", conflictId, "resolved", {}), false);
  } finally {
    db.close();
  }
});

test("resolving one of multiple conflicts keeps the batch waiting", () => {
  const { db, service } = setup();
  try {
    const secondOperation = { ...operation, clientChangeId: "change-2", path: "other.md" };
    db.prepare(
      "INSERT INTO sync_batches (id, vault_id, device_id, status, operations_json, created_at, updated_at) VALUES ('b1', 'v1', 'd1', 'waiting_for_decision', ?, 'now', 'now')"
    ).run(JSON.stringify([operation, secondOperation]));
    const internals = service as unknown as {
      createConflict(vaultId: string, batchId: string, deviceId: string, operation: SyncOperation, serverRevisionId: number | null): string;
    };
    const first = internals.createConflict("v1", "b1", "d1", operation, 42);
    internals.createConflict("v1", "b1", "d1", secondOperation, 43);

    assert.equal(service.resolveConflict("v1", first, "cancelled", {}), true);
    assert.deepEqual(db.prepare("SELECT status, failure_reason AS failureReason FROM sync_batches WHERE id = 'b1'").get(), {
      status: "waiting_for_decision",
      failureReason: null
    });
  } finally {
    db.close();
  }
});
