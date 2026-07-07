import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { RequestStatus, RequestType } from "../domain/types.js";
import { eventHub } from "./events.js";

export class RequestService {
  constructor(private readonly db: Database.Database) {}

  now(): string {
    return new Date().toISOString();
  }

  create(input: {
    vaultId?: string | null;
    type: RequestType;
    createdByDeviceId?: string | null;
    payload: unknown;
  }): string {
    const id = nanoid();
    this.db
      .prepare(
        "INSERT INTO requests (id, vault_id, type, status, created_by_device_id, payload_json, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
      )
      .run(id, input.vaultId ?? null, input.type, input.createdByDeviceId ?? null, JSON.stringify(input.payload), this.now());
    this.log(id, input.createdByDeviceId ?? null, "created", input.payload);
    eventHub.broadcast({ type: "request_created", request_id: id, request_type: input.type });
    return id;
  }

  resolve(requestId: string, deviceId: string | null, status: Exclude<RequestStatus, "pending">, decision: unknown): void {
    this.db
      .prepare("UPDATE requests SET status = ?, decision_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, JSON.stringify(decision), this.now(), requestId);
    this.log(requestId, deviceId, status, decision);
    eventHub.broadcast({ type: "request_resolved", request_id: requestId, status });
  }

  log(requestId: string, deviceId: string | null, action: string, details: unknown): void {
    this.db
      .prepare("INSERT INTO request_log (request_id, device_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, deviceId, action, JSON.stringify(details), this.now());
  }
}
