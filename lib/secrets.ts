import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Credentials for integrations, sealed with AES-256-GCM before they touch
// the database. The key is MACH_SECRETS_KEY (32 random bytes, base64), the
// same in every environment that shares the database. Sealed values start
// with a version byte so the key can be rotated later.

const VERSION = 1;

function key(): Buffer {
  const raw = process.env.MACH_SECRETS_KEY;
  if (!raw) throw new Error("Set MACH_SECRETS_KEY (openssl rand -base64 32) to store credentials.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("MACH_SECRETS_KEY must be 32 bytes, base64-encoded.");
  return bytes;
}

export function seal(value: unknown): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function unseal<T>(sealed: Uint8Array): T {
  const bytes = Buffer.from(sealed);
  if (bytes[0] !== VERSION) throw new Error("Unknown credentials format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(1, 13));
  decipher.setAuthTag(bytes.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8")) as T;
}

/** Replaces any of these secret values in text, so they never reach a model, a thread or a log. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join("[secret]");
  return out;
}
