import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// A short-lived link to one file version that works without signing in, for
// a service that fetches the file itself (Twilio, to send it on WhatsApp).
// The link is signed with MACH_SECRETS_KEY and lasts ten minutes.

const TTL_MS = 10 * 60_000;

function key(): Buffer {
  const raw = process.env.MACH_SECRETS_KEY;
  if (!raw) throw new Error("Set MACH_SECRETS_KEY to make file links.");
  return createHmac("sha256", Buffer.from(raw, "base64")).update("file-links").digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

/** A token for this version (and company), valid for ten minutes. */
export function fileLinkToken(organizationId: string, versionId: string, now = Date.now()): string {
  const payload = `${organizationId}.${versionId}.${now + TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

/** The company and version a token is for, if it's genuine and hasn't expired. */
export function readFileLinkToken(token: string, now = Date.now()): { organizationId: string; versionId: string } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [organizationId, versionId, expires] = payload.split(".");
  if (!organizationId || !versionId || !(Number(expires) > now)) return null;
  return { organizationId, versionId };
}
