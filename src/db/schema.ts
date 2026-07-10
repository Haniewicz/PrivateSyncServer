import Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      trusted INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      deleted_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      path TEXT NOT NULL,
      current_file_revision_id INTEGER,
      current_vault_revision INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(vault_id, path),
      FOREIGN KEY(vault_id) REFERENCES vaults(id)
    );

    CREATE TABLE IF NOT EXISTS file_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      vault_revision INTEGER NOT NULL,
      content_hash TEXT,
      blob_path TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      encrypted_file_key TEXT,
      plaintext_hash TEXT,
      plaintext_size INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(file_id) REFERENCES files(id),
      FOREIGN KEY(vault_id) REFERENCES vaults(id),
      FOREIGN KEY(device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS sync_batches (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_revision INTEGER,
      failure_reason TEXT,
      FOREIGN KEY(vault_id) REFERENCES vaults(id),
      FOREIGN KEY(device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS staged_blobs (
      batch_id TEXT NOT NULL,
      client_change_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      blob_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY(batch_id, client_change_id),
      FOREIGN KEY(batch_id) REFERENCES sync_batches(id)
    );

    CREATE TABLE IF NOT EXISTS staged_chunk_uploads (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      client_change_id TEXT NOT NULL,
      expected_hash TEXT NOT NULL,
      expected_size INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      received_chunks INTEGER NOT NULL DEFAULT 0,
      temp_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES sync_batches(id)
    );

    CREATE TABLE IF NOT EXISTS staged_chunk_parts (
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(upload_id, chunk_index),
      FOREIGN KEY(upload_id) REFERENCES staged_chunk_uploads(id)
    );

    CREATE TABLE IF NOT EXISTS accepted_client_changes (
      device_id TEXT NOT NULL,
      client_change_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      vault_revision INTEGER NOT NULL,
      PRIMARY KEY(device_id, client_change_id)
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      base_revision_id INTEGER,
      server_revision_id INTEGER,
      incoming_batch_id TEXT NOT NULL,
      incoming_client_change_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      decision_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      vault_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by_device_id TEXT,
      payload_json TEXT NOT NULL,
      decision_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vault_connections (
      vault_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      local_vault_instance_id TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      last_seen_revision INTEGER NOT NULL,
      last_manifest_hash TEXT NOT NULL,
      PRIMARY KEY(vault_id, device_id, local_vault_instance_id),
      FOREIGN KEY(vault_id) REFERENCES vaults(id),
      FOREIGN KEY(device_id) REFERENCES devices(id)
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      device_id TEXT,
      action TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES requests(id)
    );
  `);

  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all() as { name: string }[];
  if (!deviceColumns.some((column) => column.name === "deleted_at")) {
    db.prepare("ALTER TABLE devices ADD COLUMN deleted_at TEXT").run();
  }

  const revisionColumns = db.prepare("PRAGMA table_info(file_revisions)").all() as { name: string }[];
  if (!revisionColumns.some((column) => column.name === "plaintext_hash")) {
    db.prepare("ALTER TABLE file_revisions ADD COLUMN plaintext_hash TEXT").run();
  }
  if (!revisionColumns.some((column) => column.name === "plaintext_size")) {
    db.prepare("ALTER TABLE file_revisions ADD COLUMN plaintext_size INTEGER").run();
  }
}
