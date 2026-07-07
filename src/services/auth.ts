import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { createToken, tokenHash } from "../lib/crypto.js";
import type { DeviceType } from "../domain/types.js";

export type AuthenticatedDevice = {
  id: string;
  name: string;
  type: DeviceType;
};

export class AuthService {
  constructor(private readonly db: Database.Database) {}

  now(): string {
    return new Date().toISOString();
  }

  ensureDefaultVault(): void {
    const vault = this.db.prepare("SELECT id FROM vaults LIMIT 1").get();
    if (!vault) {
      this.db.prepare("INSERT INTO vaults (id, name, current_revision, created_at) VALUES (?, ?, 0, ?)").run("default", "Default vault", this.now());
    }
  }

  setup(password: string): void {
    this.validatePassword(password);
    const existing = this.db.prepare("SELECT id FROM users LIMIT 1").get();
    if (existing) {
      throw new Error("Server is already configured.");
    }
    const passwordHash = bcrypt.hashSync(password, 12);
    this.db.prepare("INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)").run("user", passwordHash, this.now());
    this.db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('initial_setup', 'true')").run();
    this.ensureDefaultVault();
  }

  resetPassword(password: string): void {
    this.validatePassword(password);
    const existing = this.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (!existing) {
      throw new Error("Server is not configured. Run setup first.");
    }
    const passwordHash = bcrypt.hashSync(password, 12);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, existing.id);
  }

  verifyPassword(password: string): boolean {
    const user = this.db.prepare("SELECT password_hash FROM users LIMIT 1").get() as { password_hash: string } | undefined;
    return Boolean(user && bcrypt.compareSync(password, user.password_hash));
  }

  isConfigured(): boolean {
    return Boolean(this.db.prepare("SELECT id FROM users LIMIT 1").get());
  }

  getInstanceId(): string {
    const existing = this.db.prepare("SELECT value FROM server_settings WHERE key = 'instance_id'").get() as { value: string } | undefined;
    if (existing) return existing.value;
    const instanceId = nanoid();
    this.db.prepare("INSERT INTO server_settings (key, value) VALUES ('instance_id', ?)").run(instanceId);
    return instanceId;
  }

  isInitialSetupEnabled(): boolean {
    const setting = this.db.prepare("SELECT value FROM server_settings WHERE key = 'initial_setup'").get() as { value: string } | undefined;
    return setting?.value === "true";
  }

  setInitialSetup(enabled: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('initial_setup', ?)").run(enabled ? "true" : "false");
  }

  createTrustedDevice(name: string, type: DeviceType): { deviceId: string; deviceToken: string } {
    const deviceToken = createToken();
    const deviceId = nanoid();
    this.db
      .prepare("INSERT INTO devices (id, name, type, token_hash, trusted, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(deviceId, name, type, tokenHash(deviceToken), this.now());
    this.setInitialSetup(false);
    return { deviceId, deviceToken };
  }

  authenticateDevice(token: string): AuthenticatedDevice | null {
    const device = this.db
      .prepare("SELECT id, name, type FROM devices WHERE token_hash = ? AND trusted = 1 AND revoked_at IS NULL")
      .get(tokenHash(token)) as AuthenticatedDevice | undefined;
    if (!device) return null;
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.now(), device.id);
    return device;
  }

  createRecoveryPairingCode(ttlMs: number): string {
    const code = createToken().slice(0, 24);
    this.db
      .prepare("INSERT INTO recovery_pairing_codes (id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(nanoid(), tokenHash(code), new Date(Date.now() + ttlMs).toISOString(), this.now());
    return code;
  }

  consumeRecoveryPairingCode(code: string): boolean {
    const row = this.db
      .prepare("SELECT id, expires_at, used_at FROM recovery_pairing_codes WHERE code_hash = ?")
      .get(tokenHash(code)) as { id: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return false;
    this.db.prepare("UPDATE recovery_pairing_codes SET used_at = ? WHERE id = ?").run(this.now(), row.id);
    return true;
  }

  private validatePassword(password: string): void {
    if (password.trim().length < 8) {
      throw new Error("Password must have at least 8 characters.");
    }
  }
}
