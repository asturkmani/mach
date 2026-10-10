import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { setSpecialistModel } from "@/lib/agents/specialist";
import { agentModel, listAgents, RESEARCH_AGENT, researchAgent } from "@/lib/agents/store";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { getSchedule } from "@/lib/schedules";
import { createTask, getTask, getTaskByNumber, listMessages } from "@/lib/tasks";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

async function sara() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const person = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
  const actor = { organizationId: ORG, personId: person.id, name: "Sara", userId: "user_sara", isAdmin: false };
  await doAction(actor, "source.add", { source: "@DeItaone", note: "breaking macro" });
  await doAction(actor, "source.add", { source: "semianalysis.com", note: "semis supply chain", shareWithCompany: true });
  return person;
}

describe("the Researcher", () => {
  beforeEach(async () => {
    setScheduler(() => {}); // runs are started by hand here
    await useTestDb();
  });
  afterEach(() => {
    setSpecialistModel(null);
    setScheduler(null);
    vi.unstubAllEnvs();
  });

  it("is made once, on its own model", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    vi.stubEnv("AGENT_MODEL", "solid/worker");
    vi.stubEnv("RESEARCH_AGENT_MODEL", "deep/thinker");
    const researcher = await researchAgent(ORG);
    expect(researcher).toMatchObject({ name: "Researcher", builtin: RESEARCH_AGENT, kind: "defined" });
    expect((await researchAgent(ORG)).id).toBe(researcher.id);
    expect(agentModel(researcher)).toBe("deep/thinker");
  });

  it("starts from the saved sources and sends questions to sub-researchers", async () => {
    const person = await sara();
    const researcher = await researchAgent(ORG);
    const task = await createTask(ORG, {
      title: "Brief on Micron's HBM outlook",
      description: "Is the HBM shortage priced in? For a decision on our MU position.",
      people: [person.id],
      agents: [researcher.id],
      createdBy: { personId: person.id },
    });
    const steps: Step[] = [
      [["investigate", { question: "How has HBM pricing moved since June 2026?", look_at: "SemiAnalysis first" }]],
      // The sub-researcher's report, on the same (scripted) model.
      "1. Findings:\n- Fact: HBM contract prices up 18% since June [1]\n3. Sources:\n[1] ★ SemiAnalysis, HBM update, 2026-09-30, https://semianalysis.com/hbm",
      [["finish", { summary: "HBM prices are up 18% since June: the shortage looks mostly priced in.", report: "HBM contract prices rose 18% since June…" }]],
    ];
    const model = scriptedModel(steps);
    expect(await runAgentOnTask(ORG, task.id, researcher.id, { model, research: false })).toEqual({ type: "finished" });

    const [lead, investigator] = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(lead).toContain("Load the research skill before you start");
    expect(lead).toContain("<high_signal_sources>");
    expect(lead).toContain("The sources Sara trusts most");
    expect(lead).toContain("@DeItaone: breaking macro");
    expect(lead).toContain("semianalysis.com: semis supply chain (the company's)");
    expect(investigator).toContain("You investigate one question for the Researcher");
    expect(investigator).toContain("How has HBM pricing moved since June 2026?");
    expect(investigator).toContain("Where to look: SemiAnalysis first");
    expect(investigator).toContain("@DeItaone");
    expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain("HBM contract prices up 18% since June");

    expect((await getTask(ORG, task.id))!.summary).toBe("HBM prices are up 18% since June: the shortage looks mostly priced in.");
    expect((await listMessages(task.id)).map((m) => m.author)).toContain("Researcher");
  });

  async function chat(steps: Step[]) {
    const person = (await getPerson(ORG, (await sara()).id))!;
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const model = scriptedModel(steps);
    await createChiefOfStaff(
      { organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person, profile: "# Cedar Legacy", agents: await listAgents(ORG) },
      { model, research: false },
    ).generate({ prompt: "research this" });
    return JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
  }

  it("answers a quick question in the chat, with the person's sources", async () => {
    const specialist = scriptedModel(["Mostly bearish on X today: @DeItaone flagged hawkish Fed minutes."]);
    setSpecialistModel(specialist);
    const told = await chat([
      [["start_research", { title: "Check X on the Fed minutes", question: "What's X saying about the Fed minutes?", depth: "quick" }]],
      "Done.",
    ]);
    expect(told).toContain("Researcher says:");
    expect(told).toContain("hawkish Fed minutes");
    const asked = JSON.stringify(specialist.doGenerateCalls[0].prompt);
    expect(asked).toContain("You are Researcher, Research and insight");
    expect(asked).toContain("@DeItaone: breaking macro");
    expect(await getTaskByNumber(ORG, 1)).toBeNull();
  });

  it("turns a brief into a task it reports back on, repeating when asked", async () => {
    const told = await chat([
      [
        [
          "start_research",
          {
            title: "Weekly digest on AI semis",
            question: "What my sources say about AI semis this week",
            depth: "brief",
            repeat: { cron: "0 8 * * 1", timezone: "Europe/London" },
          },
        ],
      ],
      "Done.",
    ]);
    expect(told).toContain("Started task #1: Researcher is on it");
    expect(told).toContain("Repeats:");
    const task = (await getTaskByNumber(ORG, 1))!;
    expect(task).toMatchObject({ title: "Weekly digest on AI semis", visibility: "private" });
    expect(task.members.map((m) => m.name)).toEqual(["Sara", "Researcher"]);
    expect(await getSchedule(task.id)).toMatchObject({ mode: "agent", timezone: "Europe/London" });
  });
});
