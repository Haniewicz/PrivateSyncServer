import fs from "node:fs";
import path from "node:path";
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
}
