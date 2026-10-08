import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// Email through AgentMail: each company gets an inbox for its Chief of Staff
// (e.g. cedar-legacy@agentmail.to). AgentMail posts each incoming email to
// /api/email, signed with Svix; replies go back in the same thread.

const API = "https://api.agentmail.to/v0";

export const agentmailConfigured = () => Boolean(process.env.AGENTMAIL_API_KEY);

async function call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${process.env.AGENTMAIL_API_KEY}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`AgentMail ${init.method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`), {
      status: response.status,
    });
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** A short handle for the company's inbox, e.g. "Cedar Legacy" → "cedar-legacy". */
export function inboxUsername(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "company"
  );
}

/** Creates the company's inbox, trying its name and then the name with a number. Returns its address. */
export async function createInbox(companyName: string): Promise<string> {
  const base = inboxUsername(companyName);
  for (const username of [base, ...Array.from({ length: 3 }, () => `${base}-${Math.floor(1000 + Math.random() * 9000)}`)]) {
    try {
      const inbox = await call<{ inbox_id: string; email: string }>("/inboxes", {
        method: "POST",
        body: { username, display_name: `${companyName} · Chief of Staff`.slice(0, 80) },
      });
      return inbox.email || inbox.inbox_id;
    } catch (error) {
      // Taken: try another handle.
      if ((error as { status?: number }).status !== 409 && (error as { status?: number }).status !== 400) throw error;
    }
  }
  throw new Error("Couldn't find a free email address for the company. Try again.");
}

export async function deleteInbox(inbox: string): Promise<void> {
  try {
    await call(`/inboxes/${encodeURIComponent(inbox)}`, { method: "DELETE" });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}

/** Replies to an email in its thread, as plain text. */
export async function replyToEmail(inbox: string, messageId: string, text: string): Promise<void> {
  await call(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    body: { text },
  });
}

/** Registers the webhook AgentMail posts incoming email to. Returns its signing secret. */
export async function createWebhook(url: string): Promise<{ id: string; secret: string }> {
  const webhook = await call<{ webhook_id: string; secret: string }>("/webhooks", {
    method: "POST",
    body: { url, event_types: ["message.received"] },
  });
  return { id: webhook.webhook_id, secret: webhook.secret };
}

/**
 * Svix's signature, which AgentMail's webhooks carry: HMAC-SHA256 of
 * "<svix-id>.<svix-timestamp>.<body>" with the secret after its "whsec_"
 * prefix (base64), sent as one or more space-separated "v1,<base64>".
 */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function validSvixSignature(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  now = Date.now(),
): boolean {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  // Older than five minutes (or from the future): a replay.
  if (Math.abs(now / 1000 - Number(headers.timestamp)) > 300) return false;
  const expected = Buffer.from(svixSignature(secret, headers.id, headers.timestamp, body));
  return headers.signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    const given = Buffer.from(value ?? "");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
