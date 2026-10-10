import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureEmailWebhook, inboxExists, webhookSecrets } from "@/lib/channels/agentmail";
import { getDb } from "@/lib/db";
import { useTestDb } from "@/test/db";

// AgentMail's webhooks, by account (API key): id → { url, secret }.
const accounts = new Map<string, Map<string, { url: string; secret: string }>>();
const calls: string[] = [];

function stubAgentMail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
      const hooks = accounts.get(key) ?? new Map();
      accounts.set(key, hooks);
      calls.push(`${init?.method} ${url.pathname}`);
      const id = url.pathname.split("/")[3];
      if (url.pathname === "/v0/webhooks" && init?.method === "POST") {
        const webhookId = `ep_${hooks.size + 1}_${key}`;
        const secret = `whsec_${randomBytes(16).toString("base64")}`;
        hooks.set(webhookId, { url: JSON.parse(String(init.body)).url, secret });
        return Response.json({ webhook_id: webhookId, secret });
      }
      if (url.pathname.startsWith("/v0/webhooks/") && init?.method === "GET") {
        return hooks.has(id) ? Response.json({ webhook_id: id }) : new Response("Not found", { status: 404 });
      }
      if (url.pathname.startsWith("/v0/inboxes/") && init?.method === "GET") {
        return decodeURIComponent(id) === `cedar@agentmail.to` && key === "key_new" ? Response.json({}) : new Response("Not found", { status: 404 });
      }
      return new Response("Unexpected", { status: 500 });
    }),
  );
}

describe("AgentMail's webhook, registered by Mach1 itself", () => {
  beforeEach(async () => {
    await useTestDb();
    accounts.clear();
    calls.length = 0;
    stubAgentMail();
    vi.stubEnv("MACH_SECRETS_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("AGENTMAIL_API_KEY", "key_old");
    vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leaves the webhook alone anywhere but production", async () => {
    await ensureEmailWebhook("https://trymach1.app/api/email");
    const before = calls.length;
    expect(await ensureEmailWebhook("http://localhost:3000/api/email")).toBe("skipped");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await ensureEmailWebhook("https://mach-git-feature.vercel.app/api/email")).toBe("skipped");
    expect(calls.length).toBe(before);
  });

  it("registers once per account, keeps the secret sealed, and registers again for a new key", async () => {
    const url = "https://trymach1.app/api/email";
    expect(await ensureEmailWebhook(url)).toBe("registered");
    expect(await ensureEmailWebhook(url)).toBe("ok");
    expect(calls.filter((c) => c === "POST /v0/webhooks")).toHaveLength(1);

    const [oldHook] = accounts.get("key_old")!.values();
    expect(oldHook.url).toBe(url);
    const [row] = await getDb().query<{ secret: Uint8Array }>("select secret from service_webhooks");
    expect(Buffer.from(row.secret).toString()).not.toContain(oldHook.secret.slice(6));
    expect(await webhookSecrets()).toEqual([oldHook.secret]);

    // A new AgentMail account: its own webhook, and mail signed by either is accepted while moving.
    vi.stubEnv("AGENTMAIL_API_KEY", "key_new");
    expect(await ensureEmailWebhook(url)).toBe("registered");
    const [newHook] = accounts.get("key_new")!.values();
    expect((await webhookSecrets()).sort()).toEqual([oldHook.secret, newHook.secret].sort());
  });

  it("registers again when the webhook was deleted on AgentMail's side", async () => {
    const url = "https://trymach1.app/api/email";
    await ensureEmailWebhook(url);
    accounts.get("key_old")!.clear();
    expect(await ensureEmailWebhook(url)).toBe("registered");
    expect(accounts.get("key_old")!.size).toBe(1);
  });

  it("tells whether a company's address exists on the current account", async () => {
    vi.stubEnv("AGENTMAIL_API_KEY", "key_new");
    expect(await inboxExists("cedar@agentmail.to")).toBe(true);
    vi.stubEnv("AGENTMAIL_API_KEY", "key_old");
    expect(await inboxExists("cedar@agentmail.to")).toBe(false);
  });
});
