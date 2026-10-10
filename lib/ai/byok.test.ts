import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { agentModel } from "@/lib/agents/store";
import { getDb } from "@/lib/db";
import { createOrganization, getOrganization, setCompanyModels } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

import { CompanyModel } from "./company-model";
import { AiKeyError, byokCredentials, listAiKeys, removeAiKey, saveAiKey, setGatewayCheck } from "./keys";

const ORG = "org_cedar";
const KEY = "sk-ant-api03-cedar-own-key-1234567890-WXYZ";

/** Records requests, answering the provider's key check with `status`. */
function stubFetch(status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input instanceof Request ? input.url : input), init });
      return new Response(JSON.stringify({ data: [] }), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return requests;
}

describe("bring your own key", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  beforeEach(() => setGatewayCheck(async (provider) => `${provider}/cheapest`));
  afterEach(() => {
    setGatewayCheck(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps a key only once the provider accepts it, sealed, showing its last four characters", async () => {
    const requests = stubFetch();
    expect(await saveAiKey(ORG, "anthropic", KEY, null)).toMatchObject({ hint: "WXYZ", testedOn: "anthropic/cheapest" });
    expect(requests[0].url).toContain("api.anthropic.com/v1/models");
    expect((requests[0].init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(await listAiKeys(ORG)).toMatchObject([{ provider: "anthropic", hint: "WXYZ" }]);
    const [row] = await getDb().query<{ secrets: Uint8Array }>("select secrets from ai_keys");
    expect(Buffer.from(row.secrets).toString("utf8")).not.toContain(KEY);
    expect(await byokCredentials(ORG)).toEqual({ anthropic: [{ apiKey: KEY }] });
    expect(await byokCredentials("org_other")).toEqual({});

    stubFetch(401);
    await expect(saveAiKey(ORG, "openai", "sk-proj-not-a-real-key-000000000", null)).rejects.toThrow("didn't accept");
    // The provider's own reason is shown, without the key.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Your credit balance is too low (key sk-ant-api03-cedar-own-key-1234567890-WXYZ)" } }, { status: 400 })));
    await expect(saveAiKey(ORG, "anthropic", KEY, null)).rejects.toThrow("The provider said 400 when checking the key: Your credit balance is too low (key [the key])");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header." } }, { status: 400 })));
    await expect(saveAiKey(ORG, "anthropic", KEY, null)).rejects.toThrow("This key isn't tied to a workspace");
    await expect(saveAiKey(ORG, "openai", "short", null)).rejects.toThrow("doesn't look like");
    expect((await listAiKeys(ORG)).map((k) => k.provider)).toEqual(["anthropic"]);

    // Accepted by the provider, but AI Gateway couldn't run on it (it would quietly use Mach1's): not kept.
    stubFetch();
    setGatewayCheck(async () => {
      throw new AiKeyError("AI Gateway couldn't use the key (insufficient credit).");
    });
    await expect(saveAiKey(ORG, "openai", "sk-proj-valid-but-no-credit-0000000", null)).rejects.toThrow("insufficient credit");
    expect((await listAiKeys(ORG)).map((k) => k.provider)).toEqual(["anthropic"]);

    await removeAiKey(ORG, "anthropic");
    expect(await listAiKeys(ORG)).toEqual([]);
  });

  it("sends the company's keys with each of its model calls, and tags the usage with the company", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-test-key");
    stubFetch();
    await saveAiKey(ORG, "anthropic", KEY, null);
    const requests = stubFetch();
    await generateText({ model: new CompanyModel(ORG, "anthropic/claude-sonnet-4.5"), prompt: "hi", maxRetries: 0 }).catch(() => null);
    const call = requests.find((r) => r.url.includes("ai-gateway"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call!.init.body));
    expect(JSON.stringify(body)).toContain(KEY);
    expect(JSON.stringify(body)).toContain(`org:${ORG}`);

    // Another company's calls carry nothing of Cedar's.
    requests.length = 0;
    await generateText({ model: new CompanyModel("org_other", "anthropic/claude-sonnet-4.5"), prompt: "hi", maxRetries: 0 }).catch(() => null);
    expect(JSON.stringify(requests.map((r) => r.init.body))).not.toContain(KEY);
  });

  it("is recorded by a workflow as just the company and the model, never the key", async () => {
    stubFetch();
    await saveAiKey(ORG, "anthropic", KEY, null);
    const model = new CompanyModel(ORG, "anthropic/claude-sonnet-4.5");
    const stored = CompanyModel[WORKFLOW_SERIALIZE](model);
    expect(stored).toEqual({ organizationId: ORG, modelId: "anthropic/claude-sonnet-4.5" });
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(CompanyModel[WORKFLOW_DESERIALIZE](stored)).toBeInstanceOf(CompanyModel);
  });

  it("runs Claude for a company with an Anthropic key, OpenAI otherwise, each family thinking as set, with a fallback", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-test-key");
    /** What a role's call asks AI Gateway for. */
    async function call(organizationId: string, role: string) {
      const requests = stubFetch();
      await generateText({ model: new CompanyModel(organizationId, role), prompt: "hi", maxRetries: 0 }).catch(() => null);
      const sent = requests.find((r) => r.url.includes("ai-gateway"))!;
      return JSON.stringify({ headers: sent.init.headers, body: JSON.parse(String(sent.init.body)) });
    }
    // No Anthropic key: OpenAI, on Mach1's account, with Claude to fall back on.
    let sent = await call(ORG, "mach1/chat");
    expect(sent).toContain("openai/gpt-6-luna-fast");
    expect(sent).toContain('"reasoningEffort":"low"');
    expect(sent).toContain('"models":["anthropic/claude-haiku-5.5"]');
    expect(sent).toContain('"caching":"auto"');

    stubFetch();
    await saveAiKey(ORG, "anthropic", KEY, null);
    sent = await call(ORG, "mach1/chat");
    expect(sent).toContain("anthropic/claude-haiku-5.5");
    expect(sent).toContain('"thinking":{"type":"disabled"}');
    expect(sent).toContain('"models":["openai/gpt-6-luna-fast"]');
    sent = await call(ORG, "mach1/worker");
    expect(sent).toContain("anthropic/claude-sonnet-5.5");
    expect(sent).toContain('"effort":"medium"');
    sent = await call(ORG, "mach1/planner");
    expect(sent).toContain("anthropic/claude-opus-5.5");
    expect(sent).toContain('"effort":"high"');
    // A model the company chose runs as chosen, with its family's settings and no fallback.
    sent = await call(ORG, "anthropic/claude-sonnet-5.5");
    expect(sent).toContain('"effort":"medium"');
    expect(sent).not.toContain('"models":[');
  });

  it("runs on the company's own choice of models", async () => {
    await setCompanyModels(ORG, { chiefOfStaff: "openai/gpt-5-mini", agents: " " });
    const organization = (await getOrganization(ORG))!;
    expect(organization.models).toEqual({ chiefOfStaff: "openai/gpt-5-mini" });
    // Nothing chosen for agents: the worker role, resolved per company when it runs.
    expect(agentModel({ model: null, builtin: null }, organization.models)).toBe("mach1/worker");
    expect(agentModel({ model: null, builtin: null }, { agents: "openai/gpt-5" })).toBe("openai/gpt-5");
    expect(agentModel({ model: "anthropic/claude-opus-4.5", builtin: null }, { agents: "openai/gpt-5" })).toBe("anthropic/claude-opus-4.5");

    const cos = createChiefOfStaff({ organization, user: { id: "u", email: "u@cedar.example", name: "U" }, profile: "" }, { research: false });
    const model = (cos as unknown as { settings: { model: CompanyModel } }).settings.model;
    expect(model).toBeInstanceOf(CompanyModel);
    expect(model).toMatchObject({ organizationId: ORG, modelId: "openai/gpt-5-mini" });
  });
});
