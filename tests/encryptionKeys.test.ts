import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate } from "../src/db/schema.js";

test("migration creates vault encryption keys and revision key metadata", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const keyColumns = db.prepare("PRAGMA table_info(vault_encryption_keys)").all() as Array<{ name: string }>;
    const revisionColumns = db.prepare("PRAGMA table_info(file_revisions)").all() as Array<{ name: string }>;

    assert.deepEqual(
      ["id", "vault_id", "key_check", "active", "created_at", "retired_at"].every((name) => keyColumns.some((column) => column.name === name)),
      true
    );
    assert.equal(revisionColumns.some((column) => column.name === "encryption_key_id"), true);

    db.prepare("INSERT INTO vaults (id, name, current_revision, created_at) VALUES ('v1', 'Vault', 0, 'now')").run();
    db.prepare("INSERT INTO vault_encryption_keys (id, vault_id, key_check, active, created_at) VALUES ('k1', 'v1', 'check1', 1, 'now')").run();
    db.prepare("UPDATE vault_encryption_keys SET active = 0, retired_at = 'later' WHERE id = 'k1'").run();
    db.prepare("INSERT INTO vault_encryption_keys (id, vault_id, key_check, active, created_at) VALUES ('k2', 'v1', 'check2', 1, 'later')").run();

    const active = db.prepare("SELECT id, key_check FROM vault_encryption_keys WHERE vault_id = 'v1' AND active = 1").get() as
      | { id: string; key_check: string }
      | undefined;
    assert.deepEqual(active, { id: "k2", key_check: "check2" });
  } finally {
    db.close();
  }
});
