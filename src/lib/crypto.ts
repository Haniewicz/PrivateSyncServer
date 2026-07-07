import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return sha256(token);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
