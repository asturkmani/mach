import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { setSpecialistModel } from "@/lib/agents/specialist";
import { agentModel, createAgent, listAgents, WORKER_AGENT, workerAgent } from "@/lib/agents/store";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember, updatePerson } from "@/lib/people";
import { getSchedule } from "@/lib/schedules";
import { createTask, getTask, getTaskByNumber, listMessages } from "@/lib/tasks";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

async function sara() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const linked = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
  const person = await updatePerson(ORG, linked.id, { role: "Chief Investment Officer", responsibilities: "the public portfolio" });
  const actor = { organizationId: ORG, personId: person.id, name: "Sara", userId: "user_sara", isAdmin: false };
  await doAction(actor, "source.add", { source: "@DeItaone", note: "breaking macro" });
  await doAction(actor, "source.add", { source: "semianalysis.com", note: "semis supply chain", shareWithCompany: true });
  return person;
}

describe("research: the Worker with the research skill", () => {
  beforeEach(async () => {
    setScheduler(() => {}); // runs are started by hand here
    await useTestDb();
  });
  afterEach(() => {
    setSpecialistModel(null);
    setScheduler(null);
    vi.unstubAllEnvs();
  });

  it("is done by one Worker, made once, on the company's model for agents' work", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const worker = await workerAgent(ORG);
    expect(worker).toMatchObject({ name: "Worker", builtin: WORKER_AGENT, kind: "defined" });
    expect((await workerAgent(ORG)).id).toBe(worker.id);
    expect(agentModel(worker, {}, ["research"])).toBe("mach1/worker");
  });

  it("starts from the saved sources, knowing who it's for and why", async () => {
    const person = await sara();
    const researcher = await workerAgent(ORG);
    const task = await createTask(ORG, {
      title: "Brief on Micron's HBM outlook",
      description: "Is the HBM shortage priced in? For a decision on our MU position.",
      people: [person.id],
      agents: [researcher.id],
      skills: ["research"],
      createdBy: { personId: person.id },
    });
    const steps: Step[] = [
      [["finish", { summary: "HBM prices are up 18% since June: the shortage looks mostly priced in.", report: "HBM contract prices rose 18% since June…" }]],
    ];
    const model = scriptedModel(steps);
    expect(await runAgentOnTask(ORG, task.id, researcher.id, { model, research: false })).toEqual({ type: "finished" });

    const [lead] = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(lead).toContain("This task pins these skills. They're already loaded");
    expect(lead).toContain('<skill name=\\"research\\">');
    // It knows who it's working for, and the company, without being told.
    expect(lead).toContain("This run is for Sara (Chief Investment Officer; the public portfolio)");
    expect(lead).toContain("<company_profile>");
    expect(lead).toContain("<high_signal_sources>");
    expect(lead).toContain("The sources Sara trusts most");
    expect(lead).toContain("@DeItaone: breaking macro");
    expect(lead).toContain("semianalysis.com: semis supply chain (the company's)");

    expect((await getTask(ORG, task.id))!.summary).toBe("HBM prices are up 18% since June: the shortage looks mostly priced in.");
    expect((await listMessages(task.id)).map((m) => m.author)).toContain("Worker");
  });

  it("searches with Exa once the research skill is pinned or loaded; otherwise not", async () => {
    const person = await sara();
    const worker = await workerAgent(ORG);
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const toolsOf = async (agentId: string, skills: string[] = [], steps: Step[] = [[["finish", { summary: "Done.", report: "Done." }]]]) => {
      const task = await createTask(ORG, { title: "Look into Micron", people: [person.id], agents: [agentId], skills, createdBy: { personId: person.id } });
      const model = scriptedModel(steps);
      await runAgentOnTask(ORG, task.id, agentId, { model });
      return model.doGenerateCalls.map((call) => (call.tools ?? []).map((t) => t.name));
    };
    const [pinned] = await toolsOf(worker.id, ["research"]);
    expect(pinned).toEqual(expect.arrayContaining(["web_search", "exa_search", "x_search", "reddit_search", "market_data"]));
    expect(pinned).not.toContain("investigate");
    // Loading the skill mid-run switches its tools on from the next step.
    const [before, after] = await toolsOf(worker.id, [], [[["use_skill", { name: "research" }]], [["finish", { summary: "Done.", report: "Done." }]]]);
    expect(before).not.toContain("exa_search");
    expect(after).toContain("exa_search");
    const [shared] = await toolsOf(analyst.id);
    expect(shared).toEqual(expect.arrayContaining(["web_search", "x_search", "market_data"]));
    expect(shared).not.toContain("exa_search");
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

  it("answers a quick question in the chat, knowing why it's asked and for whom", async () => {
    const specialist = scriptedModel(["Mostly bearish on X today: @DeItaone flagged hawkish Fed minutes."]);
    setSpecialistModel(specialist);
    const told = await chat([
      [
        [
          "spawn_worker",
          {
            title: "Check X on the Fed minutes",
            brief: "What's X saying about the Fed minutes?",
            why: "Deciding whether to trim our TLT position before Friday",
            skills: ["research"],
            wait: true,
          },
        ],
      ],
      "Done.",
    ]);
    expect(told).toContain("Worker says:");
    expect(told).toContain("hawkish Fed minutes");
    const asked = JSON.stringify(specialist.doGenerateCalls[0].prompt);
    expect(asked).toContain("You are Worker, Does the work");
    expect(asked).toContain('<skill name=\\"research\\">');
    expect(asked).toContain("asking you a question for Sara (Chief Investment Officer; the public portfolio)");
    expect(asked).toContain("Why: Deciding whether to trim our TLT position before Friday");
    expect(asked).toContain("<company_profile>");
    expect(asked).toContain("@DeItaone: breaking macro");
    expect(await getTaskByNumber(ORG, 1)).toBeNull();
  });

  it("turns a brief into a task it reports back on, repeating when asked", async () => {
    const told = await chat([
      [
        [
          "spawn_worker",
          {
            title: "Weekly digest on AI semis",
            brief: "What my sources say about AI semis this week",
            why: "Keeping our semis positions under review",
            context: "We hold MU and NVDA. Sara thinks HBM pricing is the swing factor.",
            deliverable: "Five bullets and anything that changes the view",
            skills: ["research"],
            repeat: { cron: "0 8 * * 1", timezone: "Europe/London", mode: "agent" },
          },
        ],
      ],
      "Done.",
    ]);
    expect(told).toContain("Started task #1: Worker is on it, with research.");
    expect(told).toContain("Repeats:");
    const task = (await getTaskByNumber(ORG, 1))!;
    expect(task).toMatchObject({ title: "Weekly digest on AI semis", visibility: "private" });
    // The hand-off from the chat, which the Worker reads as the task's description.
    expect(task.description).toBe(
      [
        "What my sources say about AI semis this week",
        "Why: Keeping our semis positions under review",
        "For: Sara (Chief Investment Officer; the public portfolio)",
        "What matters: We hold MU and NVDA. Sara thinks HBM pricing is the swing factor.",
        "What they want back: Five bullets and anything that changes the view",
      ].join("\n\n"),
    );
    expect(task.members.map((m) => m.name)).toEqual(["Sara", "Worker"]);
    expect(task.skills).toEqual(["research"]);
    expect(await getSchedule(task.id)).toMatchObject({ mode: "agent", timezone: "Europe/London" });
  });
});
