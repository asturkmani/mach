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

  it("runs on the company's own choice of models", async () => {
    vi.stubEnv("CHIEF_OF_STAFF_MODEL", "mach1/assistant");
    vi.stubEnv("AGENT_MODEL", "mach1/worker");
    await setCompanyModels(ORG, { chiefOfStaff: "openai/gpt-5-mini", agents: " " });
    const organization = (await getOrganization(ORG))!;
    expect(organization.models).toEqual({ chiefOfStaff: "openai/gpt-5-mini" });
    expect(agentModel({ model: null, builtin: null }, organization.models)).toBe("mach1/worker");
    expect(agentModel({ model: null, builtin: null }, { agents: "openai/gpt-5" })).toBe("openai/gpt-5");
    expect(agentModel({ model: "anthropic/claude-opus-4.5", builtin: null }, { agents: "openai/gpt-5" })).toBe("anthropic/claude-opus-4.5");

    const cos = createChiefOfStaff({ organization, user: { id: "u", email: "u@cedar.example", name: "U" }, profile: "" }, { research: false });
    const model = (cos as unknown as { settings: { model: CompanyModel } }).settings.model;
    expect(model).toBeInstanceOf(CompanyModel);
    expect(model).toMatchObject({ organizationId: ORG, modelId: "openai/gpt-5-mini" });
  });
});
