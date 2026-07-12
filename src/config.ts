import path from "node:path";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  blobDir: string;
  protocolVersion: string;
  serverVersion: string;
  maxUploadSize: number;
  maxBatchSize: number;
  trustProxy: boolean;
  authRateLimitMax: number;
  authRateLimitWindowSeconds: number;
  pairingStatusRateLimitMax: number;
  pairingStatusRateLimitWindowSeconds: number;
  proxyHost: string;
  proxyPort: number;
  proxyTarget: string;
  proxyProto: string;
};

const dataDir = process.env.PRIVATE_SYNC_DATA_DIR ?? path.resolve(process.cwd(), "data");

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export const config: ServerConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, "server.sqlite"),
  blobDir: process.env.BLOB_DIR ?? path.join(dataDir, "blobs"),
  protocolVersion: "1",
  serverVersion: "1.0.0",
  maxUploadSize: 100 * 1024 * 1024,
  maxBatchSize: 500,
  trustProxy: booleanEnv("TRUST_PROXY"),
  authRateLimitMax: numberEnv("AUTH_RATE_LIMIT_MAX", 10),
  authRateLimitWindowSeconds: numberEnv("AUTH_RATE_LIMIT_WINDOW_SECONDS", 60),
  pairingStatusRateLimitMax: numberEnv("PAIRING_STATUS_RATE_LIMIT_MAX", 30),
  pairingStatusRateLimitWindowSeconds: numberEnv("PAIRING_STATUS_RATE_LIMIT_WINDOW_SECONDS", 60),
  proxyHost: process.env.PROXY_HOST ?? "::",
  proxyPort: numberEnv("PROXY_PORT", 8787),
  proxyTarget: process.env.PROXY_TARGET ?? "http://127.0.0.1:8788",
  proxyProto: process.env.PROXY_PROTO ?? "https"
};
