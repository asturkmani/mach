import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { agentToWake, dispatchRun, setScheduler } from "@/lib/agents/dispatch";
import { MAX_AGENT_TURNS, normalizeOptions, runAgentOnTask, taskBrief } from "@/lib/agents/runner";
import { createAgent, createWorker } from "@/lib/agents/store";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { listTaskFiles } from "@/lib/files";
import { setSandboxProvider } from "@/lib/sandbox";
import { addMessage, createTask, getTask, listMessages } from "@/lib/tasks";
import { replyToTask } from "@/lib/work";
import { fakeSandboxes } from "@/test/fake-sandbox";
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
    expect((await listTaskFiles(ORG, task.id)).map((f) => [f.name, f.kind, f.versions[0].version])).toEqual([
      ["micron-model.csv", "deliverable", 1],
    ]);
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
    const { addMember } = await import("@/lib/tasks");
    await addMember(task.id, { agentId: writer.id });

    // One model for both agents: each one's instructions say who it is.
    const scripts = {
      [analyst.name]: scriptedModel([[["hand_off", { to: writer.name, note: "Write it up.", summary: "Numbers done, writing up." }]]]),
      [writer.name]: scriptedModel([[["finish", { summary: "Write-up ready.", report: "Here it is." }]]]),
    };
    const ran: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        const name = Object.keys(scripts).find((n) => JSON.stringify(call.prompt).includes(`You are ${n},`))!;
        ran.push(name);
        return scripts[name].doGenerate(call);
      },
    });
    const work: Promise<void>[] = [];
    setScheduler((job) => work.push(job()), { model, research: false });

    await dispatchRun(ORG, task.id, analyst.id);
    await Promise.all(work);
    expect(ran).toEqual([analyst.name, writer.name]);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", summary: "Write-up ready." });
    expect((await listMessages(task.id)).map((m) => [m.author, m.kind])).toEqual([
      ["Analyst", "update"],
      ["Writing worker", "result"],
    ]);
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

describe("agent runs with a sandbox", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("runs code in the job's sandbox, attaches the results and keeps the job's notes", async () => {
    const { ahmed, analyst, task } = await setUp();
    const sandboxes = fakeSandboxes({
      "simulate.py": (files) => {
        files.set("/vercel/job/outputs/portfolio-model.xlsx", Buffer.from(`model for ${files.get("/vercel/job/config.json")}`));
        files.set("/vercel/job/NOTES.md", Buffer.from("# Notes\n- 60/40: median 6.1%"));
        return { stdout: "median 6.1%" };
      },
    });
    setSandboxProvider(sandboxes.provider);

    const outcome = await run(task.id, analyst.id, [
      [["write_file", { path: "config.json", content: "60/40" }]],
      [["run_code", { filename: "simulate.py", language: "python", code: "print('median 6.1%')" }]],
      [["attach_file", { path: "outputs/portfolio-model.xlsx", note: "60/40" }]],
      [["finish", { summary: "Median 1-year return is 6.1%. Model attached.", report: "Done." }]],
    ]);
    expect(outcome).toEqual({ type: "finished" });

    const name = `mach-task-${task.id}`;
    // Attaching an xlsx recalculates it first, so its values preview correctly.
    expect(sandboxes.log).toEqual([`create ${name}`, "run simulate.py", expect.stringContaining("recalc"), `stop ${name}`]);
    const files = await listTaskFiles(ORG, task.id);
    // The model, then the code that made it, including the config it read.
    expect(files.map((f) => [f.name, f.kind, f.versions.map((v) => v.version)])).toEqual([
      ["portfolio-model.xlsx", "deliverable", [1]],
      ["simulate.py", "code", [1]],
      ["config.json", "code", [1]],
    ]);
    expect(files[1].versions[0].note).toContain("median 6.1%");
    expect(await getTask(ORG, task.id)).toMatchObject({ sandboxName: name, memory: "# Notes\n- 60/40: median 6.1%" });

    // A reply next week: the same sandbox, the same scripts, the next version of the model.
    sandboxes.machines.get(name)!.files.set("/vercel/job/config.json", Buffer.from("60/40"));
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), {
      model: scriptedModel([
        [["write_file", { path: "config.json", content: "70/30" }]],
        [["run_code", { filename: "simulate.py", language: "python", code: "print('median 6.1%')" }]],
        [["attach_file", { path: "outputs/portfolio-model.xlsx", note: "70/30" }]],
        [["finish", { summary: "70/30 lifts the median to 6.9%.", report: "Done." }]],
      ]),
      research: false,
    });
    await replyToTask(ORG, task.id, { name: "Ahmed", personId: ahmed.id }, "Try 70/30 instead");
    await Promise.all(runs);

    expect(sandboxes.log.filter((l) => l.startsWith("create"))).toHaveLength(1);
    const [model] = await listTaskFiles(ORG, task.id);
    expect(model.versions.map((v) => [v.version, v.note])).toEqual([
      [2, "70/30"],
      [1, "60/40"],
    ]);
  });

  it("never starts a sandbox for work that doesn't need one", async () => {
    const { analyst, task } = await setUp();
    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    await run(task.id, analyst.id, [[["finish", { summary: "Done.", report: "Done." }]]]);
    expect(sandboxes.log).toEqual([]);
  });

  it("seeds a new job's sandbox with the files it starts from", async () => {
    const { ahmed, analyst } = await setUp();
    const { saveVersion, attachToTask } = await import("@/lib/files");
    const earlier = await createTask(ORG, { title: "Old model", people: [ahmed.id] });
    const v1 = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("v1"), taskId: earlier.id });
    const task = await createTask(ORG, { title: "Extend the model", people: [ahmed.id], agents: [analyst.id] });
    await attachToTask(ORG, task.id, v1.fileId, "input");

    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    await run(task.id, analyst.id, [
      [["list_files", {}]],
      [["finish", { summary: "Done.", report: "Done." }]],
    ]);
    expect(sandboxes.file(`mach-task-${task.id}`, "inputs/model.xlsx")?.toString()).toBe("v1");
    expect(sandboxes.file(`mach-task-${task.id}`, "NOTES.md")?.toString()).toBe("# Job notes\n");
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
    const brief = taskBrief({ task, messages, files: [], agent });
    expect(brief).toContain("message 0\n");
    expect(brief).not.toContain("message 10\n");
    expect(brief).toContain("message 69");
  });
});
