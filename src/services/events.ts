import { WebSocket } from "ws";

export type ServerEvent =
  | { type: "vault_changed"; vault_id: string; latest_revision: number }
  | { type: "request_created"; request_id: string; request_type: string }
  | { type: "request_resolved"; request_id: string; status: string }
  | { type: "conflict_created"; conflict_id: string; vault_id: string; path: string }
  | { type: "conflict_resolved"; conflict_id: string; vault_id: string; status: string }
  | { type: "device_revoked"; device_id: string }
  | { type: "server_status"; status: string };

export class EventHub {
  private sockets = new Map<string, Set<WebSocket>>();

  add(deviceId: string, socket: WebSocket): void {
    const sockets = this.sockets.get(deviceId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.sockets.set(deviceId, sockets);
    socket.on("close", () => sockets.delete(socket));
  }

  broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        }
      }
    }
  }
}

export const eventHub = new EventHub();
