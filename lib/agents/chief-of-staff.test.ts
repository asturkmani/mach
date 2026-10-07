import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffInstructions, createChiefOfStaff } from "./chief-of-staff";
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

type Step = Array<[toolName: string, input: object]> | string;

// Plays back one model step per call: a list of (parallel) tool calls, or a final text reply.
function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      if (typeof step === "string") {
        return {
          content: [{ type: "text" as const, text: step }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: step.map(([name, input], i) => toolCall(`${call}-${i}`, name, input)),
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const essentials: Step = [
  ["update_section", { section: "Overview", content: "Single-family office for the Cedar family." }],
  ["save_person", { name: "Ahmed", role: "Principal", reportsTo: "" }],
  ["save_person", { name: "Mustapha", role: "Finance lead", reportsTo: "Ahmed", responsibilities: "Masttro" }],
  ["update_section", { section: "Goals", content: "- Manage cash flow\n- AI-first operations" }],
];

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
      // Like the real model, it calls complete_onboarding alongside the saves, then again.
      {
        model: scriptedModel([[...essentials, ["complete_onboarding", {}]], [["complete_onboarding", {}]], "You're set up."]),
        research: false,
      },
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

  it("won't finish onboarding while someone besides the top person has no manager", async () => {
    const organization = await setUpOrg();
    const model = scriptedModel([
      [
        ["update_section", { section: "Overview", content: "Family office." }],
        ["save_person", { name: "Mustapha", role: "Finance lead" }],
        ["update_section", { section: "Goals", content: "- Cash flow" }],
      ],
      [["complete_onboarding", {}]],
      "Who does Mustapha report to?",
    ]);
    const agent = createChiefOfStaff({ organization, user, profile: await loadProfile(ORG) }, { model, research: false });
    await agent.generate({ prompt: "Mustapha does finance." });

    expect((await getOrganization(ORG))!.onboardingCompletedAt).toBeNull();
    const lastPrompt = JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
    expect(lastPrompt).toContain("Not complete yet. Missing: Team and reporting lines (2 people, 1 needs a manager)");
  });

  it("offers research tools, reads the website first and drops the interview after onboarding", async () => {
    const organization = await setUpOrg();
    const onboarding = createChiefOfStaff({ organization, user, profile: "" }, { model: scriptedModel(["Hi"]) });
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

  it("refuses to start without a model", async () => {
    const organization = await setUpOrg();
    delete process.env.CHIEF_OF_STAFF_MODEL;
    expect(() => createChiefOfStaff({ organization, user, profile: "" })).toThrow(/CHIEF_OF_STAFF_MODEL/);
  });
});
