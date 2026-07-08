import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

type Bucket = {
  count: number;
  resetAt: number;
};

type LimitRule = {
  name: string;
  method: string;
  matcher: (url: string) => boolean;
  max: number;
  windowMs: number;
};

const loginWindowMs = config.authRateLimitWindowSeconds * 1000;
const pollingWindowMs = config.pairingStatusRateLimitWindowSeconds * 1000;
const buckets = new Map<string, Bucket>();

const rules: LimitRule[] = [
  {
    name: "auth_login",
    method: "POST",
    matcher: (url) => url === "/api/v1/auth/login",
    max: config.authRateLimitMax,
    windowMs: loginWindowMs
  },
  {
    name: "device_request",
    method: "POST",
    matcher: (url) => url === "/api/v1/devices/request",
    max: config.authRateLimitMax,
    windowMs: loginWindowMs
  },
  {
    name: "device_request_status",
    method: "POST",
    matcher: (url) => /^\/api\/v1\/devices\/request\/[^/]+\/status$/.test(url),
    max: config.pairingStatusRateLimitMax,
    windowMs: pollingWindowMs
  }
];

export async function registerRateLimit(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", async (request, reply) => {
    const rule = findRule(request);
    if (!rule) return;
    const allowed = consume(rule, clientIp(request));
    if (!allowed) {
      await rateLimited(reply, rule.windowMs);
    }
  });
}

function findRule(request: FastifyRequest): LimitRule | null {
  if (request.method !== "POST") return null;
  const url = request.url.split("?")[0] ?? request.url;
  return rules.find((rule) => rule.method === request.method && rule.matcher(url)) ?? null;
}

function consume(rule: LimitRule, ip: string): boolean {
  const now = Date.now();
  cleanup(now);
  const key = rule.name + ":" + ip;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= rule.max;
}

function clientIp(request: FastifyRequest): string {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.ip;
}

function cleanup(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

async function rateLimited(reply: FastifyReply, windowMs: number): Promise<void> {
  await reply
    .code(429)
    .header("retry-after", String(Math.ceil(windowMs / 1000)))
    .send({ error: "rate_limited" });
}
