import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { db } from "./db/database.js";
import { registerAuth } from "./http/authPlugin.js";
import { registerRoutes } from "./http/routes.js";
import { AuthService } from "./services/auth.js";
import { eventHub } from "./services/events.js";

const fastify = Fastify({ logger: true, bodyLimit: config.maxUploadSize });
await fastify.register(cors);
await fastify.register(multipart, { limits: { fileSize: config.maxUploadSize } });
await registerAuth(fastify);
await registerRoutes(fastify);

const server = await fastify.listen({ host: config.host, port: config.port });

const auth = new AuthService(db);
const wss = new WebSocketServer({ server: fastify.server, path: "/api/v1/events" });
wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "", server);
  const token = url.searchParams.get("token");
  const device = token ? auth.authenticateDevice(token) : null;
  if (!device) {
    socket.close(1008, "unauthorized");
    return;
  }
  eventHub.add(device.id, socket);
  socket.send(JSON.stringify({ type: "server_status", status: "connected" }));
});
