import { validateUIMessages, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffInstructions, createChiefOfStaff, withoutResearchResults } from "./chief-of-staff";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember, listPeople, syncPeopleSection } from "@/lib/people";
import { getSection, onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";
const user = { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function toolCall(id: string, toolName: string, input: object) {
  return { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) };
}

// First model call: record the essentials via tools (in parallel). Second: reply.
function scriptedModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            toolCall("1", "update_section", { section: "Overview", content: "Single-family office for the Cedar family." }),
            toolCall("2", "save_person", { name: "Ahmed", role: "Principal", reportsTo: "" }),
            toolCall("3", "save_person", { name: "Mustapha", role: "Finance lead", reportsTo: "Ahmed", responsibilities: "Masttro" }),
            toolCall("4", "update_section", { section: "Goals", content: "- Manage cash flow\n- AI-first operations" }),
            toolCall("5", "complete_onboarding", {}),
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "You're set up." }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

async function setUpOrg() {
  await createOrganization({ id: ORG, name: "Cedar Legacy", website: "https://cedar.example" });
  await linkMember(ORG, user);
  await syncPeopleSection(ORG);
  return (await getOrganization(ORG))!;
}

describe("Chief of Staff", () => {
  beforeEach(async () => {
    await useTestDb();
  });

  it("records the essentials for the signed-in company and finishes onboarding", async () => {
    const organization = await setUpOrg();
    const agent = createChiefOfStaff(
      { organization, user, profile: await loadProfile(ORG) },
      { model: scriptedModel(), research: false },
    );
    const result = await agent.generate({ prompt: "We're a family office. Mustapha runs Masttro and reports to me." });
    expect(result.text).toBe("You're set up.");

    expect((await listPeople(ORG)).map((p) => [p.name, p.role, p.managerName, p.status])).toEqual([
      ["Ahmed", "Principal", null, "active"],
      ["Mustapha", "Finance lead", "Ahmed", "not_invited"],
    ]);

    const profile = await loadProfile(ORG);
    expect(getSection(profile, "Overview")).toBe("Single-family office for the Cedar family.");
    expect(getSection(profile, "People & Responsibilities")).toContain("- **Ahmed**, Principal\n  - **Mustapha**, Finance lead");
    expect(onboardingChecklist(profile).every((item) => item.done)).toBe(true);
    expect((await getOrganization(ORG))!.onboardingCompletedAt).toBeInstanceOf(Date);
  });

  it("offers research tools, reads the website first and drops the interview after onboarding", async () => {
    const organization = await setUpOrg();
    const onboarding = createChiefOfStaff({ organization, user, profile: "" }, { model: scriptedModel() });
    expect(onboarding.tools).toHaveProperty("web_search");
    expect(onboarding.tools).toHaveProperty("fetch_page");

    expect(chiefOfStaffInstructions({ organization, user, profile: "" })).toContain(
      "read it with fetch_page",
    );
    expect(chiefOfStaffInstructions({ organization, user, profile: "" })).toContain("https://cedar.example");

    const done = { ...organization, onboardingCompletedAt: new Date() };
    expect(chiefOfStaffInstructions({ organization: done, user, profile: "" })).toContain("Onboarding is complete");
    expect(chiefOfStaffInstructions({ organization: done, user, profile: "" })).not.toContain("fetch_page");
  });

  it("drops web search results from the history so the next message validates", async () => {
    const organization = await setUpOrg();
    const agent = createChiefOfStaff({ organization, user, profile: "" }, { model: scriptedModel() });
    // The shape AI Gateway actually returns for a Parallel search.
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hi, let's get set up." }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-web_search",
            toolCallId: "call_1",
            state: "output-available",
            providerExecuted: true,
            input: { objective: "What is Cedar Legacy?" },
            output: {
              search_id: "search_1",
              results: [{ url: "https://www.cedarlegacy.com/", title: "Cedar Legacy", excerpts: ["A family office."] }],
              usage: [{ name: "sku_search", count: 1 }],
            },
          },
          { type: "text", text: "You're a family office. Right?" },
        ],
      },
      { id: "a2", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-fetch_page", toolCallId: "call_2", state: "output-available", providerExecuted: true, input: { url: "https://www.cedarlegacy.com/" }, output: { raw: true } }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "Yes." }] },
    ] as unknown as UIMessage[];

    await expect(validateUIMessages({ messages, tools: agent.tools })).rejects.toThrow(/web_search/);

    const cleaned = withoutResearchResults(messages);
    expect(cleaned.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(cleaned[1].parts.map((p) => p.type)).toEqual(["step-start", "text"]);
    await expect(validateUIMessages({ messages: cleaned, tools: agent.tools })).resolves.toHaveLength(3);
  });

  it("refuses to start without a model", async () => {
    const organization = await setUpOrg();
    delete process.env.CHIEF_OF_STAFF_MODEL;
    expect(() => createChiefOfStaff({ organization, user, profile: "" })).toThrow(/CHIEF_OF_STAFF_MODEL/);
  });
});
