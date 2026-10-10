import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { setPlannerModel } from "@/lib/agents/planner";
import { createAgent, listAgents } from "@/lib/agents/store";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { getTask, getTaskByNumber, listMessages } from "@/lib/tasks";
import { createTaskWithTeam, setStatus } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

/** Agents finish with a result; dispatched runs queue up and are worked through in order. */
function runAgents() {
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => scriptedModel([[["finish", { summary: "Delivered.", report: `Done: ${JSON.stringify(call.prompt).includes("You are Writer") ? "write-up" : "numbers"}.` }]]]).doGenerate(call),
  });
  const work: (() => Promise<void>)[] = [];
  setScheduler((job) => work.push(job), { model, research: false });
  return async () => {
    while (work.length) await work.shift()!();
  };
}

describe("planned jobs", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => {
    setScheduler(null);
    setPlannerModel(null);
  });

  it("starts a later step by itself once everything it waits for is delivered", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const writer = await createAgent(ORG, { name: "Writer" });
    const by = { name: "Sara", personId: sara.id };
    const drain = runAgents();

    const numbers = await createTaskWithTeam(ORG, { title: "Pull the Q3 numbers", agentIds: [analyst.id], by });
    const approval = await createTaskWithTeam(ORG, { title: "Approve the template", by });
    const writeUp = await createTaskWithTeam(ORG, { title: "Write the Q3 report", agentIds: [writer.id], after: [numbers.id, approval.id], by });
    expect(writeUp).toMatchObject({ status: "backlog", waitsFor: [numbers.number, approval.number] });
    expect((await listMessages(writeUp.id)).at(-1)?.body).toBe(`Created this task. It starts once #${numbers.number} and #${approval.number} are delivered.`);

    // The analyst delivers; the write-up still waits for the approval.
    await drain();
    expect((await getTask(ORG, numbers.id))!.status).toBe("review");
    expect((await getTask(ORG, writeUp.id))!.status).toBe("backlog");

    // Approved: the writer starts and delivers too.
    await setStatus(ORG, approval.id, "done", by);
    await drain();
    expect(await getTask(ORG, writeUp.id)).toMatchObject({ status: "review", summary: "Delivered." });
    expect((await listMessages(writeUp.id)).map((m) => m.body)).toContain(`Starting: #${approval.number} is delivered.`);

    // Already delivered: a new step starts straight away.
    const appendix = await createTaskWithTeam(ORG, { title: "Add an appendix", agentIds: [writer.id], after: [numbers.id], by });
    expect(appendix.status).not.toBe("backlog");
  });

  it("has the Chief of Staff plan a big job with the planner, then create its steps in order", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    await createAgent(ORG, { name: "Analyst", role: "Financial analysis" });
    await createAgent(ORG, { name: "Writer", role: "Reports" });
    setScheduler(() => {}); // the agents' runs aren't part of this test
    const plan = "Goal: a Q3 report for the family.\nAsk first: none\nSteps:\n1. Pull the Q3 numbers | who: Analyst | after: none\n2. Write the Q3 report | who: Writer | after: 1\nRisks: none";
    const planner = scriptedModel([plan]);
    setPlannerModel(planner);
    const model = scriptedModel([
      { text: "On it: planning the Q3 report.", calls: [["plan_job", { request: "Q3 report for the family by Friday" }]] },
      [["create_task", { title: "Pull the Q3 numbers", description: "From Masttro.", agents: ["Analyst"] }]],
      [["create_task", { title: "Write the Q3 report", description: "From #1's numbers.", agents: ["Writer"], after: [1] }]],
      "Planned: #1 pulls the numbers, then #2 writes it up.",
    ]);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    await createChiefOfStaff(
      { organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person: (await getPerson(ORG, sara.id))!, profile: "", agents: await listAgents(ORG) },
      { model, research: false },
    ).generate({ prompt: "Can you get the Q3 report for the family done by Friday?" });

    const asked = JSON.stringify(planner.doGenerateCalls[0].prompt);
    expect(asked).toContain("Q3 report for the family by Friday");
    expect(asked).toContain("Analyst (Financial analysis)");
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("2. Write the Q3 report | who: Writer | after: 1");
    expect(await getTaskByNumber(ORG, 2)).toMatchObject({ title: "Write the Q3 report", status: "backlog", waitsFor: [1] });
    expect(JSON.stringify(model.doGenerateCalls[3].prompt)).toContain("It starts once #1 is delivered.");
  });
});
