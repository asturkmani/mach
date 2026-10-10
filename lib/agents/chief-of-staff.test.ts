import { beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffInstructions, createChiefOfStaff } from "./chief-of-staff";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember, listPeople, syncPeopleSection } from "@/lib/people";
import { getSection, onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent, listAgents } from "@/lib/agents/store";
import { listTaskFiles } from "@/lib/files";
import { getTaskByNumber, listInbox } from "@/lib/tasks";
import { pickOption } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const user = { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" };

const essentials: Array<[string, object]> = [
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

  it("finishes onboarding for a company of one once they say it's just them", async () => {
    const organization = await setUpOrg();
    const model = scriptedModel([
      [
        ["update_section", { section: "Overview", content: "Solo bookkeeping practice." }],
        ["save_person", { name: "Ahmed", role: "Founder", reportsTo: "" }],
        ["update_section", { section: "Goals", content: "- Ten clients" }],
      ],
      // Without justMe, a lone person isn't taken as the whole team.
      [["complete_onboarding", {}]],
      [["complete_onboarding", { justMe: true }]],
      "You're set up.",
    ]);
    const agent = createChiefOfStaff({ organization, user, profile: await loadProfile(ORG) }, { model, research: false });
    await agent.generate({ prompt: "It's just me. I do bookkeeping for small firms." });

    const prompts = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.at(-2)).toContain("Not complete yet. Missing: Team and reporting lines (1 person)");
    expect((await getOrganization(ORG))!.onboardingCompletedAt).toBeInstanceOf(Date);
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
    expect(chiefOfStaffInstructions({ organization: done, user, profile: "" })).not.toContain("read it with fetch_page");
  });

  it("tells an admin once that an Anthropic key runs Claude, never asking for it in chat", async () => {
    const organization = { ...(await setUpOrg()), onboardingCompletedAt: new Date() };
    const said = (extra: object) => chiefOfStaffInstructions({ organization, user, profile: "", ...extra });
    expect(said({ isAdmin: true, aiKeys: [] })).toContain("add the company's Anthropic API key in Settings → AI");
    expect(said({ isAdmin: true, aiKeys: [] })).toContain("never in chat");
    expect(said({ isAdmin: true, aiKeys: ["anthropic"] })).not.toContain("Anthropic API key");
    expect(said({ isAdmin: false, aiKeys: [] })).not.toContain("Anthropic API key");
  });

  it("runs on the chat role unless the company chose a model", async () => {
    const organization = await setUpOrg();
    const modelOf = (agent: ReturnType<typeof createChiefOfStaff>) => (agent as unknown as { settings: { model: { modelId: string } } }).settings.model.modelId;
    expect(modelOf(createChiefOfStaff({ organization, user, profile: "" }, { research: false }))).toBe("mach1/chat");
    expect(modelOf(createChiefOfStaff({ organization: { ...organization, models: { chiefOfStaff: "openai/gpt-6.1-sol" } }, user, profile: "" }, { research: false }))).toBe("openai/gpt-6.1-sol");
  });

  it("turns a request into a task for the Worker, which runs and reports back", async () => {
    const organization = { ...(await setUpOrg()), onboardingCompletedAt: new Date() };
    const person = (await listPeople(ORG))[0];
    const runs: Promise<void>[] = [];
    // Agents run on their own script, in the test instead of after the response.
    setScheduler((work) => runs.push(work()), {
      model: scriptedModel([
        [["save_output", { filename: "model.csv", content: "Line item,FQ1E\nRevenue ($M),100" }]],
        [["finish", { summary: "Model ready: revenue grows to $100M. Share it?", report: "Done.", options: [{ label: "Share it" }] }]],
      ]),
      research: false,
    });
    const model = scriptedModel([
      [["use_skill", { name: "writing-tasks" }]],
      [
        [
          "create_task",
          {
            title: "Review Micron's latest earnings",
            description: "Earnings review plus a model with projections for the next 4 quarters.",
            workerRole: "Financial analysis",
          },
        ],
      ],
      "On it: a financial analysis worker is reviewing Micron. It'll land in your inbox.",
    ]);
    const agent = createChiefOfStaff({ organization, user, person, profile: await loadProfile(ORG) }, { model, research: false });
    await agent.generate({ prompt: "Do Micron latest earnings review and create a financial model with projections for next 4 quarters" });
    await Promise.all(runs);
    setScheduler(null);

    const task = (await getTaskByNumber(ORG, 1))!;
    expect(task.members.map((m) => [m.type, m.name])).toEqual([
      ["person", "Ahmed"],
      ["agent", "Worker"],
    ]);
    expect(task.description).toMatch(/^Kind of work: Financial analysis\n\n/);
    expect(task).toMatchObject({ status: "review", summary: "Model ready: revenue grows to $100M. Share it?" });
    expect((await listTaskFiles(ORG, task.id)).map((f) => f.name)).toEqual(["model.csv"]);
    expect((await listInbox(ORG, person.id)).map((t) => t.number)).toEqual([1]);
    expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).toContain("Created task #1 with Ahmed, Worker.");
  });

  it("only offers profile edits that fit the moment, and suggests changes after onboarding", async () => {
    const organization = { ...(await setUpOrg()), onboardingCompletedAt: new Date() };
    const person = (await listPeople(ORG))[0];
    await createAgent(ORG, { name: "Bookkeeper", role: "Bookkeeping" });
    const model = scriptedModel([
      [
        [
          "suggest_profile_update",
          { section: "How We Work", content: "- Masttro for portfolio reporting", reason: "You use Masttro. Add it to How We Work?" },
        ],
      ],
      "Noted.",
    ]);
    const agent = createChiefOfStaff(
      { organization, user, person, profile: await loadProfile(ORG), agents: await listAgents(ORG) },
      { model, research: false },
    );
    await agent.generate({ prompt: "We report on Masttro." });

    const offered = model.doGenerateCalls[0].tools?.map((t) => t.name) ?? [];
    expect(offered).toContain("suggest_profile_update");
    expect(offered).not.toContain("update_section");
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("- Bookkeeper (Bookkeeping)");

    const [suggestion] = await listInbox(ORG, person.id);
    expect(suggestion).toMatchObject({ kind: "suggestion", summary: "You use Masttro. Add it to How We Work?" });
    expect(getSection(await loadProfile(ORG), "How We Work")).toBe("_Not yet captured._");
    await pickOption(ORG, suggestion.id, { name: "Ahmed", personId: person.id }, 0);
    expect(getSection(await loadProfile(ORG), "How We Work")).toBe("- Masttro for portfolio reporting");
    expect(await listInbox(ORG, person.id)).toEqual([]);

    const onboarding = scriptedModel(["Hi"]);
    await createChiefOfStaff({ organization: await getOrganization(ORG).then((o) => ({ ...o!, onboardingCompletedAt: null })), user, profile: "" }, { model: onboarding, research: false }).generate({ prompt: "Hi" });
    const duringOnboarding = onboarding.doGenerateCalls[0].tools?.map((t) => t.name) ?? [];
    expect(duringOnboarding).toContain("update_section");
    expect(duringOnboarding).not.toContain("suggest_profile_update");
  });
});
