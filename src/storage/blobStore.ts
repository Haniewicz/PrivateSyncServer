import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "../lib/crypto.js";

export class BlobStore {
  constructor(private readonly blobDir: string) {
    fs.mkdirSync(blobDir, { recursive: true });
  }

  put(content: Buffer): { hash: string; relativePath: string; size: number } {
    const hash = sha256(content);
    const relativePath = path.join(hash.slice(0, 2), hash.slice(2, 4), hash);
    const fullPath = path.join(this.blobDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content);
    }
    return { hash, relativePath, size: content.byteLength };
  }

  get(relativePath: string): Buffer {
    return fs.readFileSync(path.join(this.blobDir, relativePath));
  }

  getPath(relativePath: string): string {
    return path.join(this.blobDir, relativePath);
  }

  putFromChunkFiles(chunkPaths: string[]): { hash: string; relativePath: string; size: number } {
    const hash = createHash("sha256");
    let size = 0;
    const tempPath = path.join(this.blobDir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(path.dirname(tempPath), { recursive: true });
    try {
      for (const chunkPath of chunkPaths) {
        const chunk = fs.readFileSync(chunkPath);
        hash.update(chunk);
        size += chunk.byteLength;
        fs.appendFileSync(tempPath, chunk);
      }
    } finally {
      // The temporary file is either renamed into the blob store or removed below.
    }

    const contentHash = hash.digest("hex");
    const relativePath = path.join(contentHash.slice(0, 2), contentHash.slice(2, 4), contentHash);
    const fullPath = path.join(this.blobDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (fs.existsSync(fullPath)) {
      fs.rmSync(tempPath, { force: true });
    } else {
      fs.renameSync(tempPath, fullPath);
    }
    return { hash: contentHash, relativePath, size };
  }
}
