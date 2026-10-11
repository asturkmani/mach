import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { agentModel, coordinatorAgent, createAgent, listAgents, workerAgent } from "@/lib/agents/store";
import { listTaskFiles } from "@/lib/files";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { getTask, getTaskByNumber, listChildren, listInbox, listMessages, listTasks } from "@/lib/tasks";
import { createTaskWithTeam, replyToTask, setStatus } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

type Call = Parameters<MockLanguageModelV4["doGenerate"]>[0];
const text = (call: Call) => JSON.stringify(call.prompt);

/**
 * One model for every run, answering as whoever is running: the coordinator
 * plays its script in order across its runs; each worker answers from what
 * its task is about.
 */
function models(coordinator: Step[], worker: (prompt: string) => Step) {
  const coordinating = scriptedModel(coordinator);
  const calls = { coordinator: [] as string[], worker: [] as string[] };
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      if (text(call).includes("You are Coordinator")) {
        calls.coordinator.push(text(call));
        return coordinating.doGenerate(call);
      }
      calls.worker.push(text(call));
      return scriptedModel([worker(text(call))]).doGenerate(call);
    },
  });
  const work: (() => Promise<void>)[] = [];
  setScheduler((job) => work.push(job), { model, research: false });
  const drain = async () => {
    while (work.length) await work.shift()!();
  };
  return { calls, drain };
}

const finish = (summary: string, report = summary): Step => [["finish", { summary, report }]];

describe("jobs", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => setScheduler(null));

  async function sara() {
    const person = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    return { person, by: { name: "Sara", personId: person.id } };
  }

  it("are started from chat with start_job, for the Coordinator on the planner model", async () => {
    const { person } = await sara();
    setScheduler(() => {}); // the coordinator's run isn't part of this test
    const model = scriptedModel([
      [
        [
          "start_job",
          {
            title: "Brief on memory pricing",
            request: "Where DRAM and HBM pricing go in 2027, for our MU and SK hynix positions.",
            why: "Deciding whether to add to MU before earnings",
            skills: ["research"],
          },
        ],
      ],
      "On it.",
    ]);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    await createChiefOfStaff(
      { organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person: (await getPerson(ORG, person.id))!, profile: "", agents: await listAgents(ORG) },
      { model, research: false },
    ).generate({ prompt: "dig into memory pricing for 2027" });

    expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).toContain("Started job #1: the Coordinator is planning it.");
    const job = (await getTaskByNumber(ORG, 1))!;
    expect(job.members.map((m) => m.name)).toEqual(["Sara", "Coordinator"]);
    expect(job.skills).toEqual(["research"]);
    expect(job.description).toContain("Why: Deciding whether to add to MU before earnings");
    expect(agentModel(await coordinatorAgent(ORG), {}, job.skills)).toBe("mach1/planner");
    // Even on a job that came from a coding task.
    expect(agentModel(await coordinatorAgent(ORG), {}, ["coding-in-github"])).toBe("mach1/planner");
  });

  it("run their children as a batch, wake once when it's in, and report once", async () => {
    const { by } = await sara();
    const { calls, drain } = models(
      [
        // First run: the plan, two children as one batch, then wait.
        [["post_update", { message: "Plan: DRAM pricing and HBM supply, then the brief." }]],
        [
          ["start_child", { assignee: "worker", title: "DRAM pricing outlook", brief: "Contract DRAM prices into 2027.", skills: ["research"] }],
          ["start_child", { assignee: "worker", title: "HBM supply outlook", brief: "HBM supply and pricing into 2027.", skills: ["research"] }],
        ],
        [["wait_for_children", { note: "Two questions out." }]],
        // Second run: everything's in.
        [["collect_file", { child: 2, name: "dram.md" }]],
        finish("Memory brief ready: DRAM up 12%, HBM tight through 2027."),
      ],
      (prompt) => {
        const topic = prompt.includes("DRAM pricing outlook") ? "dram" : "hbm";
        return [
          ["save_output", { filename: `${topic}.md`, content: `Findings on ${topic}` }],
          ["finish", { summary: `${topic} findings are in.`, report: `Fact: ${topic} findings [1]` }],
        ];
      },
    );
    const coordinator = await coordinatorAgent(ORG);
    const job = await createTaskWithTeam(ORG, { title: "Brief on memory pricing", agentIds: [coordinator.id], skills: ["research"], by });
    await drain();

    const children = await listChildren(ORG, job.id);
    // Reporting closed them, so a repeating job's next round starts clean.
    expect(children.map((c) => [c.number, c.assigneeKind, c.batch, c.status, c.skills])).toEqual([
      [2, "worker", 1, "done", ["research"]],
      [3, "worker", 1, "done", ["research"]],
    ]);
    // Children are for the person the job is for, with only the Worker on them.
    expect(children.every((c) => c.createdByPersonId === by.personId && c.members.map((m) => m.name).join() === "Worker")).toBe(true);
    // A child knows it reports to the coordinator; the coordinator woke once for the batch, and saw what came back.
    expect(calls.worker[0]).toContain("This task is part of job #1");
    expect(calls.coordinator).toHaveLength(5); // three steps in its first run, two in its second
    expect(calls.coordinator.at(-1)).toContain("<children>");
    expect(calls.coordinator.at(-1)).toContain("Fact: dram findings [1]");
    expect((await listMessages(job.id)).map((m) => m.body)).toContain("Everything started is in: #2, #3.");

    expect(await getTask(ORG, job.id)).toMatchObject({ status: "review", summary: "Memory brief ready: DRAM up 12%, HBM tight through 2027." });
    expect((await listTaskFiles(ORG, job.id)).map((f) => f.name)).toEqual(["dram.md"]);
    // One report: the job is in Sara's inbox and on the board; its workers' children aren't.
    expect((await listInbox(ORG, by.personId)).map((t) => t.number)).toEqual([1]);
    expect((await listTasks(ORG)).map((t) => t.number)).toEqual([1]);
  });

  it("wakes the coordinator straight away for a child's question, and gives a person their own list", async () => {
    const { by } = await sara();
    const rita = await linkMember(ORG, { id: "user_rita", email: "rita@cedar.example", name: "Rita" });
    let asked = false;
    const { calls, drain } = models(
      [
        [["start_child", { assignee: "worker", title: "Tag this week's transactions", brief: "Tag the 20 untagged ones." }]],
        [["start_child", { assignee: "person", person: "Rita", title: "Confirm 3 tags for Hassan's entities", brief: "Are these right? ..." }]],
        // Not yet: both are working.
        finish("Done."),
        [["wait_for_children", {}]],
        // Woken by the worker's question: it can't wait until it answers.
        [["wait_for_children", {}]],
        [["message_child", { child: 2, text: "ACME is Hassan's." }]],
        [["wait_for_children", {}]],
        // Everything is in, Rita's answer too.
        finish("Tagged 20; Rita confirmed Hassan's 3."),
      ],
      (prompt) => {
        if (!asked) {
          asked = true;
          return [["ask", { summary: "Which entity is ACME under?", question: "Which entity is ACME under?" }]];
        }
        return finish("Tagged all 20.", prompt.includes("ACME is Hassan's.") ? "Tagged, ACME under Hassan." : "Tagged.");
      },
    );
    const coordinator = await coordinatorAgent(ORG);
    const job = await createTaskWithTeam(ORG, { title: "Weekly tagging", agentIds: [coordinator.id], by });
    await drain();

    const [worker, list] = await listChildren(ORG, job.id);
    expect(worker).toMatchObject({ status: "review", summary: "Tagged all 20." });
    // Rita's list is hers alone: it's in her inbox, not Sara's, and it waits on her.
    expect(list).toMatchObject({ assigneeKind: "person", status: "waiting" });
    expect(list.members.map((m) => m.name)).toEqual(["Rita"]);
    expect((await listInbox(ORG, rita.id)).map((t) => t.number)).toEqual([list.number]);
    expect((await listInbox(ORG, by.personId)).map((t) => t.number)).toEqual([]);
    expect(calls.coordinator.some((p) => p.includes("still working: wait_for_children"))).toBe(true);
    expect(calls.coordinator.some((p) => p.includes("is waiting on you: answer with message_child"))).toBe(true);
    expect((await getTask(ORG, job.id))!.status).toBe("in_progress");

    // Rita answers on her list: it's in, and the coordinator reports.
    await replyToTask(ORG, list.id, { name: "Rita", personId: rita.id }, "All three are right.");
    await drain();
    // Answered, then closed with the rest when the job reported.
    expect((await getTask(ORG, list.id))!.status).toBe("done");
    expect((await listMessages(list.id)).map((m) => m.body)).toContain("Answered.");
    expect(calls.coordinator.at(-1)).toContain("All three are right.");
    expect(await getTask(ORG, job.id)).toMatchObject({ status: "review", summary: "Tagged 20; Rita confirmed Hassan's 3." });
  });

  it("cancel a child and everything that waits on it, however indirectly", async () => {
    const { by } = await sara();
    const { calls, drain } = models(
      [
        [["start_child", { assignee: "person", person: "Sara", title: "Pick the three companies", brief: "Which three?" }]],
        [["start_child", { assignee: "worker", title: "Model each company", brief: "Build the models.", after: [2] }]],
        [["start_child", { assignee: "worker", title: "Build the deck", brief: "From the models.", after: [3] }]],
        [["cancel_child", { child: 2, why: "They chose the companies in the chat." }]],
        [["start_child", { assignee: "worker", title: "Too late", brief: "After the deck.", after: [4] }]],
        finish("Stopped: nothing left to do."),
      ],
      () => finish("Done."),
    );
    const coordinator = await coordinatorAgent(ORG);
    const job = await createTaskWithTeam(ORG, { title: "Memory stocks", agentIds: [coordinator.id], by });
    await drain();

    expect((await listChildren(ORG, job.id)).map((c) => [c.number, c.status])).toEqual([
      [2, "cancelled"],
      [3, "cancelled"],
      [4, "cancelled"],
    ]);
    expect(calls.coordinator.some((p) => p.includes("Cancelled #2, #3, #4."))).toBe(true);
    expect(calls.coordinator.some((p) => p.includes("#4 was cancelled, so it would never start."))).toBe(true);
    expect((await getTask(ORG, job.id))!.status).toBe("review");
  });

  it("are what a worker's task becomes when it escalates, starting from what it found", async () => {
    const { by } = await sara();
    const { calls, drain } = models([finish("Planned and done.")], () => [
      ["escalate", { why: "There are eight bugs, not one.", found: "Issues #12, #14 and six more since last night." }],
    ]);
    const worker = await workerAgent(ORG);
    const task = await createTaskWithTeam(ORG, { title: "Fix last night's bug", agentIds: [worker.id], skills: ["coding-in-github"], by });
    await drain();

    const job = (await getTask(ORG, task.id))!;
    expect(job.members.map((m) => m.name)).toEqual(["Sara", "Coordinator"]);
    expect(calls.worker[0]).toContain("escalate:");
    expect(calls.coordinator[0]).toContain("What I found so far:\\nIssues #12, #14 and six more since last night.");
    expect(job).toMatchObject({ status: "review", summary: "Planned and done." });
  });

  it("starts a later step by itself once everything it waits for is delivered", async () => {
    const { by } = await sara();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const writer = await createAgent(ORG, { name: "Writer" });
    const { drain } = models([], (prompt) => finish("Delivered.", prompt.includes("You are Writer") ? "write-up" : "numbers"));

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

  it("still reads tasks the Chief of Staff created before tasks could wait", async () => {
    const organization = (await getOrganization(ORG))!;
    const tools = createChiefOfStaff({ organization, user: { id: "u", email: "u@cedar.example", name: "U" }, profile: "" }, { research: false }).tools as unknown as Record<
      string,
      { toModelOutput: (options: { output: unknown }) => { value: string } }
    >;
    const stored = { task: { id: "t1", number: 4, title: "Old task" }, members: ["Sara", "Analyst"], repeats: null };
    expect(tools.create_task.toModelOutput({ output: stored }).value).toBe("Created task #4 with Sara, Analyst.");
  });
});
