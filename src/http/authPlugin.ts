import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/database.js";
import { AuthService, type AuthenticatedDevice } from "../services/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    device?: AuthenticatedDevice;
  }
}

const auth = new AuthService(db);

export async function registerAuth(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest("device");
  fastify.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1")) return;
    if (
      request.url.startsWith("/api/v1/server-info") ||
      request.url.startsWith("/api/v1/auth/login") ||
      request.url.startsWith("/api/v1/devices/request")
    ) {
      return;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) {
      await unauthorized(reply);
      return;
    }
    const device = auth.authenticateDevice(token);
    if (!device) {
      await unauthorized(reply);
      return;
    }
    request.device = device;
  });
}

async function unauthorized(reply: FastifyReply): Promise<void> {
  await reply.code(401).send({ error: "unauthorized" });
}
