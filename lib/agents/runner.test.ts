import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ after: vi.fn() }));

import { agentToWake, dispatchRun, setScheduler } from "@/lib/agents/dispatch";
import { MAX_AGENT_TURNS, normalizeOptions, runAgentOnTask, taskBrief } from "@/lib/agents/runner";
import { createAgent, createWorker } from "@/lib/agents/store";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { addMessage, createTask, getTask, listMessages, listOutputs, updateTask } from "@/lib/tasks";
import { scriptedModel, type Step } from "@/test/scripted-model";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const analyst = await createAgent(ORG, {
    name: "Analyst",
    role: "Financial analysis",
    description: "Reviews earnings and builds models.",
  });
  const task = await createTask(ORG, {
    title: "Review Micron's latest earnings",
    description: "Build a model with projections for the next 4 quarters.",
    people: [ahmed.id],
    agents: [analyst.id],
  });
  return { ahmed, analyst, task };
}

const run = (taskId: string, agentId: string, steps: Step[]) =>
  runAgentOnTask(ORG, taskId, agentId, { model: scriptedModel(steps), research: false });

describe("agent runs", () => {
  beforeEach(async () => {
    setScheduler(null);
    await useTestDb();
  });

  it("works the task, saves files and reports back into the inbox", async () => {
    const { analyst, task } = await setUp();
    const outcome = await run(task.id, analyst.id, [
      [["use_skill", { name: "financial-analysis" }]],
      [
        ["post_update", { message: "Pulled the FQ4 release.", progress: "Read the earnings release" }],
        ["save_output", { filename: "micron-model.csv", content: "Line item,FQ1 2027E\nRevenue ($M),12000" }],
      ],
      [
        [
          "finish",
          {
            summary: "FQ4 revenue was $11.3B, up 46%. Model projects $12.0B next quarter. Share it?",
            report: "Revenue grew 46% year on year…",
            options: [{ label: "Share with Lina" }, { label: "Revise assumptions" }],
            context: "Ahmed asked for a Micron earnings review and a 4-quarter model.",
            progress: "Read the earnings release\nBuilt the model",
          },
        ],
      ],
    ]);

    expect(outcome).toEqual({ type: "finished" });
    const done = (await getTask(ORG, task.id))!;
    expect(done).toMatchObject({
      status: "review",
      summary: "FQ4 revenue was $11.3B, up 46%. Model projects $12.0B next quarter. Share it?",
      options: [
        { label: "Share with Lina", recommended: true },
        { label: "Revise assumptions", recommended: false },
      ],
      progress: "Read the earnings release\nBuilt the model",
      runStartedAt: null,
    });
    expect((await listMessages(task.id)).map((m) => [m.author, m.kind])).toEqual([
      ["Analyst", "update"],
      ["Analyst", "result"],
    ]);
    expect((await listOutputs(task.id)).map((o) => o.filename)).toEqual(["micron-model.csv"]);
  });

  it("asks a question and waits on the people on the task", async () => {
    const { analyst, task } = await setUp();
    await run(task.id, analyst.id, [
      [["ask", { summary: "Which fiscal year should the model start from?", question: "FY26 or FY27?" }]],
    ]);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "waiting", options: [] });
  });

  it("shows the agent everything on the task, including other agents' work", async () => {
    const { ahmed, analyst, task } = await setUp();
    const researcher = await createWorker(ORG, "Research");
    await addMessage(task.id, { author: "Ahmed", personId: ahmed.id, body: "Focus on HBM." });
    await addMessage(task.id, { author: researcher.name, agentId: researcher.id, kind: "result", body: "HBM is 20% of revenue." });

    const model = scriptedModel([[["finish", { summary: "Done.", report: "Done." }]]]);
    await runAgentOnTask(ORG, task.id, analyst.id, { model, research: false });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Build a model with projections for the next 4 quarters.");
    expect(prompt).toContain("Focus on HBM.");
    expect(prompt).toContain("HBM is 20% of revenue.");
    expect(prompt).toContain("Analyst (defined agent, Financial analysis) ← you");
    expect(prompt).toContain("Cedar Legacy");
  });

  it("hands off to another agent on the task, which runs next", async () => {
    const { analyst, task } = await setUp();
    const writer = await createWorker(ORG, "Writing");
    await updateTask(ORG, task.id, {});
    const { addMember } = await import("@/lib/tasks");
    await addMember(task.id, { agentId: writer.id });

    const steps: Record<string, Step[]> = {
      [analyst.id]: [[["hand_off", { to: writer.name, note: "Write it up.", summary: "Numbers done, writing up." }]]],
      [writer.id]: [[["finish", { summary: "Write-up ready.", report: "Here it is." }]]],
    };
    const ran: string[] = [];
    const work: Promise<void>[] = [];
    setScheduler((job) => work.push(job()));
    const { runAgentOnTask: realRun } = await import("@/lib/agents/runner");
    // Run each agent with its own script.
    vi.spyOn(await import("@/lib/agents/runner"), "runAgentOnTask").mockImplementation(async (org, id, agentId) => {
      ran.push(agentId);
      return realRun(org, id, agentId, { model: scriptedModel(steps[agentId]), research: false });
    });

    dispatchRun(ORG, task.id, analyst.id);
    await Promise.all(work);
    expect(ran).toEqual([analyst.id, writer.id]);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", summary: "Write-up ready." });
    vi.restoreAllMocks();
  });

  it("parks the task for a person when a run fails or agents loop", async () => {
    const { analyst, task } = await setUp();
    const failed = await run(task.id, analyst.id, [new Error("Gateway timeout")]);
    expect(failed).toEqual({ type: "failed", error: "Gateway timeout" });
    expect(await getTask(ORG, task.id)).toMatchObject({
      status: "waiting",
      summary: "Analyst couldn't finish: Gateway timeout",
      options: [{ label: "Try again", recommended: true }],
      runStartedAt: null,
    });

    for (let i = 1; i < MAX_AGENT_TURNS; i++) await run(task.id, analyst.id, [[["finish", { summary: "Again.", report: "." }]]]);
    expect(await run(task.id, analyst.id, [[["finish", { summary: "Again.", report: "." }]]])).toMatchObject({
      type: "skipped",
    });
    expect((await getTask(ORG, task.id))!.summary).toMatch(/turns in a row/);
  });

  it("picks who to wake after a person replies", async () => {
    const { analyst, task } = await setUp();
    const writer = await createWorker(ORG, "Writing");
    const { addMember } = await import("@/lib/tasks");
    await addMember(task.id, { agentId: writer.id });
    await addMessage(task.id, { author: writer.name, agentId: writer.id, kind: "ask", body: "Tone?" });
    const fresh = (await getTask(ORG, task.id))!;
    const messages = await listMessages(task.id);

    expect(agentToWake(fresh, messages, "Formal please")).toBe(writer.id);
    expect(agentToWake(fresh, messages, "@Analyst check the numbers")).toBe(analyst.id);
    expect(agentToWake(fresh, [], "")).toBe(analyst.id);
  });
});

describe("normalizeOptions", () => {
  it("recommends exactly one option", () => {
    expect(normalizeOptions([{ label: "A" }, { label: "B", recommended: true }, { label: "C", recommended: true }])).toEqual([
      { label: "A", recommended: false },
      { label: "B", recommended: true },
      { label: "C", recommended: false },
    ]);
    expect(normalizeOptions([])).toEqual([]);
  });
});

describe("taskBrief", () => {
  beforeEach(async () => {
    await useTestDb();
  });

  it("keeps the opening message of a long thread", async () => {
    const { analyst, task } = await setUp();
    const agent = analyst;
    const messages = Array.from({ length: 70 }, (_, i) => ({
      id: String(i),
      author: "Ahmed",
      personId: null,
      agentId: null,
      kind: "comment" as const,
      body: `message ${i}`,
      createdAt: new Date(),
    }));
    const brief = taskBrief({ task, messages, outputs: [], agent });
    expect(brief).toContain("message 0\n");
    expect(brief).not.toContain("message 10\n");
    expect(brief).toContain("message 69");
  });
});
