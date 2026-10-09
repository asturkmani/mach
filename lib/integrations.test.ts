import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent } from "@/lib/agents/store";
import { getDb } from "@/lib/db";
import { createOrganization } from "@/lib/orgs";
import { addMessage, createTask, listMessages } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import {
  callIntegration,
  fill,
  getIntegration,
  IntegrationError,
  listIntegrations,
  recentCalls,
  sandboxPolicy,
  saveCredentials,
  saveIntegration,
  testIntegration,
  type ApiConfig,
} from "./integrations";
import { redact, seal, unseal } from "./secrets";

const ORG = "org_cedar";
const KEY = "mst_live_7f3a9c2e1b";

const masttro = (patch: Partial<ApiConfig> = {}): ApiConfig => ({
  baseUrl: "https://api.masttro.example/v1/",
  domains: [],
  fields: [{ name: "apiKey", label: "API key" }],
  headers: { Authorization: "Bearer {{apiKey}}" },
  testPath: "/me",
  ...patch,
});

/** A fake API: records requests and answers with whatever the handler returns. */
function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      const out = handler(url, init);
      const body = out.text ?? JSON.stringify(out.json ?? {});
      return new Response(body, { status: out.status ?? 200, headers: { "content-type": out.text ? "text/plain" : "application/json" } });
    }),
  );
  return requests;
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("integrations", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seals credentials and redacts them from text", () => {
    const sealed = seal({ apiKey: KEY });
    expect(sealed.toString("utf8")).not.toContain(KEY);
    expect(unseal<{ apiKey: string }>(sealed)).toEqual({ apiKey: KEY });
    expect(redact(`echo ${KEY} and ${KEY}`, [KEY, "abc"])).toBe("echo [secret] and [secret]");
    expect(fill("Basic {{basic:user:pass}}", { user: "a", pass: "b" })).toBe(`Basic ${Buffer.from("a:b").toString("base64")}`);
  });

  it("checks a data source's setup", async () => {
    const saved = await saveIntegration(ORG, { kind: "api", name: "Masttro", config: masttro() });
    expect(saved).toMatchObject({ slug: "masttro", status: "needs_credentials", hasCredentials: false, access: "read", agentIds: null });
    expect(saved.config).toMatchObject({ baseUrl: "https://api.masttro.example/v1", domains: ["api.masttro.example"] });
    await expect(
      saveIntegration(ORG, { kind: "api", name: "Bad", config: masttro({ headers: { Authorization: "Bearer {{apikey}}" } }) }),
    ).rejects.toThrow(/doesn't match a credential field/);
    await expect(saveIntegration(ORG, { kind: "api", name: "Plain", config: masttro({ baseUrl: "http://x.example" }) })).rejects.toThrow(
      /https/,
    );
  });

  it("signs requests, keeps to its domains, enforces read-only and logs every call", async () => {
    const { id } = await saveIntegration(ORG, { kind: "api", name: "Masttro", config: masttro() });
    await expect(callIntegration(ORG, "masttro", { path: "/me" })).rejects.toThrow(/haven't been entered/);

    // A key pasted into a thread by mistake is scrubbed when it's saved properly.
    const task = await createTask(ORG, { title: "Pull positions" });
    await addMessage(task.id, { author: "Ahmed", body: `the key is ${KEY}` });
    await getDb().query("insert into chats (id, organization_id, user_id, messages) values ('c1', $1, 'u1', $2::jsonb)", [
      ORG,
      JSON.stringify([{ id: "m1", role: "user", parts: [{ type: "text", text: `here: ${KEY}` }] }]),
    ]);
    await saveCredentials(ORG, id, { apiKey: KEY });
    expect((await listMessages(task.id))[0].body).toBe("the key is [secret]");
    const [chat] = await getDb().query<{ messages: unknown }>("select messages from chats where id = 'c1'");
    expect(JSON.stringify(chat.messages)).not.toContain(KEY);

    const requests = fakeFetch((url) => ({ json: { path: url.pathname, echo: `token ${KEY}` } }));
    const agent = await createAgent(ORG, { name: "Analyst" });
    const result = await callIntegration(ORG, "masttro", { path: "positions", query: { asOf: "2026-10-06" } }, { taskId: task.id, agentId: agent.id });
    expect(result.status).toBe(200);
    expect(requests[0].url.toString()).toBe("https://api.masttro.example/v1/positions?asOf=2026-10-06");
    expect(header(requests[0].init, "Authorization")).toBe(`Bearer ${KEY}`);
    expect(result.text).toContain("token [secret]");

    await expect(callIntegration(ORG, "masttro", { method: "POST", path: "/positions", body: {} })).rejects.toThrow(/read-only/);
    await expect(callIntegration(ORG, "masttro", { path: "https://evil.example/steal" })).rejects.toThrow(/isn't one of/);
    expect(requests).toHaveLength(1);
    expect((await recentCalls(id)).map((c) => [c.method, c.path, c.status, c.agentName, c.taskNumber])).toEqual([
      ["GET", "/v1/positions", 200, "Analyst", task.number],
    ]);

    fakeFetch(() => ({ status: 401, text: "bad key" }));
    expect((await testIntegration(ORG, id)).status).toBe("failing");
  });

  it("swaps credentials for a token and reuses it until it nearly expires", async () => {
    const { id } = await saveIntegration(ORG, {
      kind: "api",
      name: "Custodian",
      config: masttro({
        baseUrl: "https://api.custodian.example",
        fields: [
          { name: "clientId", label: "Client ID", secret: false },
          { name: "clientSecret", label: "Client secret" },
        ],
        headers: { Authorization: "Bearer {{token}}" },
        token: {
          url: "https://auth.custodian.example/oauth/token",
          format: "form",
          body: { grant_type: "client_credentials", client_id: "{{clientId}}", client_secret: "{{clientSecret}}" },
          path: "access_token",
          expiresInPath: "expires_in",
        },
      }),
    });
    await saveCredentials(ORG, id, { clientId: "cedar", clientSecret: "s3cr3t-value" });
    const requests = fakeFetch((url) =>
      url.hostname === "auth.custodian.example" ? { json: { access_token: "tok-123456", expires_in: 3600 } } : { json: { ok: true } },
    );
    await callIntegration(ORG, "custodian", { path: "/accounts" });
    await callIntegration(ORG, "custodian", { path: "/accounts" });
    expect(requests.map((r) => r.url.hostname)).toEqual(["auth.custodian.example", "api.custodian.example", "api.custodian.example"]);
    expect(Object.fromEntries(new URLSearchParams(String(requests[0].init.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "cedar",
      client_secret: "s3cr3t-value",
    });
    expect(header(requests[1].init, "Authorization")).toBe("Bearer tok-123456");
  });

  it("gives each agent's sandbox the sources it may use, read-only enforced at the network layer", async () => {
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const clerk = await createAgent(ORG, { name: "Data entry" });
    const open = await saveIntegration(ORG, { kind: "api", name: "Masttro", config: masttro() });
    const limited = await saveIntegration(ORG, {
      kind: "api",
      name: "Ledger",
      config: masttro({ baseUrl: "https://ledger.example", headers: { "X-Api-Key": "{{apiKey}}" } }),
      access: "write",
      agentIds: [clerk.id],
    });
    await saveCredentials(ORG, open.id, { apiKey: KEY });
    await saveCredentials(ORG, limited.id, { apiKey: "ledger-key-123" });

    const forAnalyst = await sandboxPolicy(ORG, analyst.id);
    expect(forAnalyst.sources).toEqual(["masttro"]);
    expect(forAnalyst.policy).toEqual({
      allow: {
        "api.masttro.example": [
          { match: { method: ["GET", "HEAD"] }, transform: [{ headers: { Authorization: `Bearer ${KEY}` } }] },
          { response: { statusCode: 403, contentType: "text/plain", body: "Mach1: Masttro is read-only, so only GET requests are allowed." } },
        ],
        "*": [],
      },
    });
    const forClerk = await sandboxPolicy(ORG, clerk.id);
    expect(forClerk.sources).toEqual(["ledger", "masttro"]);
    expect((forClerk.policy as { allow: Record<string, unknown> }).allow["ledger.example"]).toEqual([
      { transform: [{ headers: { "X-Api-Key": "ledger-key-123" } }] },
    ]);
    expect((await listIntegrations(ORG, { agentId: analyst.id })).map((i) => i.slug)).toEqual(["masttro"]);
    await expect(callIntegration(ORG, "ledger", { path: "/" }, { agentId: analyst.id })).rejects.toBeInstanceOf(IntegrationError);
    expect((await getIntegration(ORG, "ledger"))?.agentIds).toEqual([clerk.id]);
  });
});
