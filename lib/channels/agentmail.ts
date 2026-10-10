import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { appUrl } from "@/lib/app-url";
import { getDb } from "@/lib/db";
import { seal, unseal } from "@/lib/secrets";

// Email through AgentMail: each company gets an inbox for its Chief of Staff
// (e.g. cedar-legacy@agentmail.to). AgentMail posts each incoming email to
// /api/email, signed with Svix; replies go back in the same thread. Mach1
// registers that webhook itself, on whichever AgentMail account its key
// belongs to (ensureEmailWebhook), so a new key needs nothing else.

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

/** True when the signature was made with one of these secrets (Mach1's webhooks), recently. */
export function validSvixSignature(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  secrets: string[],
  now = Date.now(),
): boolean {
  if (!secrets.length || !headers.id || !headers.timestamp || !headers.signature) return false;
  // Older than five minutes (or from the future): a replay.
  if (Math.abs(now / 1000 - Number(headers.timestamp)) > 300) return false;
  return secrets.some((secret) => {
    const expected = Buffer.from(svixSignature(secret, headers.id!, headers.timestamp!, body));
    return headers.signature!.split(" ").some((entry) => {
      const [version, value] = entry.split(",");
      const given = Buffer.from(value ?? "");
      return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
}

/** Which API key (so which AgentMail account) a webhook was registered with, without keeping the key. */
const keyService = () => `agentmail:${createHash("sha256").update(process.env.AGENTMAIL_API_KEY ?? "").digest("hex").slice(0, 16)}`;

/**
 * Makes sure AgentMail posts incoming email to this app: the webhook is
 * registered on the key's account, pointing here. Registers it (once) when
 * it's missing, for a new key or a new address, and keeps its secret sealed.
 */
export async function ensureEmailWebhook(url = appUrl("/api/email")): Promise<"ok" | "registered" | "skipped"> {
  if (!agentmailConfigured()) throw new Error("AgentMail isn't set up (AGENTMAIL_API_KEY).");
  // Only production looks after the webhook. A preview, or a laptop with the same key and database, would
  // otherwise replace production's webhook with its own, taking the company's incoming email (and AgentMail
  // only posts to https anyway).
  if (process.env.VERCEL_ENV !== "production" || !url.startsWith("https://")) return "skipped";
  const service = keyService();
  const [row] = await getDb().query<{ webhook_id: string; url: string }>("select webhook_id, url from service_webhooks where service = $1", [
    service,
  ]);
  if (row) {
    const exists = await call(`/webhooks/${encodeURIComponent(row.webhook_id)}`, { method: "GET" }).then(
      () => true,
      (error) => {
        if ((error as { status?: number }).status === 404) return false;
        throw error;
      },
    );
    if (exists && row.url === url) return "ok";
    // Pointing somewhere else: the new one replaces it.
    if (exists) await call(`/webhooks/${encodeURIComponent(row.webhook_id)}`, { method: "DELETE" }).catch(() => {});
  }
  const webhook = await createWebhook(url);
  await getDb().query(
    `insert into service_webhooks (service, url, webhook_id, secret) values ($1, $2, $3, $4)
     on conflict (service) do update set url = excluded.url, webhook_id = excluded.webhook_id, secret = excluded.secret, created_at = now()`,
    [service, url, webhook.id, seal(webhook.secret)],
  );
  return "registered";
}

/** The secrets incoming email may be signed with: the webhooks Mach1 registered, and AGENTMAIL_WEBHOOK_SECRET if set. */
export async function webhookSecrets(): Promise<string[]> {
  const rows = await getDb().query<{ secret: Uint8Array }>("select secret from service_webhooks where service like 'agentmail:%'");
  const secrets = rows.flatMap((row) => {
    try {
      return [unseal<string>(row.secret)];
    } catch {
      return [];
    }
  });
  if (process.env.AGENTMAIL_WEBHOOK_SECRET) secrets.push(process.env.AGENTMAIL_WEBHOOK_SECRET);
  return secrets;
}

/** Whether this inbox exists on the key's AgentMail account (it doesn't after moving to another account). */
export async function inboxExists(inbox: string): Promise<boolean> {
  return call(`/inboxes/${encodeURIComponent(inbox)}`, { method: "GET" }).then(
    () => true,
    (error) => {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    },
  );
}
