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
};

const dataDir = process.env.PRIVATE_SYNC_DATA_DIR ?? path.resolve(process.cwd(), "data");

export const config: ServerConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, "server.sqlite"),
  blobDir: process.env.BLOB_DIR ?? path.join(dataDir, "blobs"),
  protocolVersion: "1",
  serverVersion: "0.1.0",
  maxUploadSize: 100 * 1024 * 1024,
  maxBatchSize: 500
};
