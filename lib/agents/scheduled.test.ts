import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { deleteDriveFile, listDrive, readDriveFile } from "@/lib/drive";
import { listTaskFiles } from "@/lib/files";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { getSchedule } from "@/lib/schedules";
import { createTask, getTask, listMessages, updateTask } from "@/lib/tasks";
import { fireDueSchedules, rerunScript } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const analyst = await createAgent(ORG, { name: "Analyst", role: "Markets" });
  const task = await createTask(ORG, {
    title: "Chart the option flow every weekday at 16:00",
    people: [ahmed.id],
    agents: [analyst.id],
  });
  return { ahmed, analyst, task };
}

/** run.sh as the agent wrote it: pulls the day's flow into the drive and redraws the chart. */
function flowSandboxes() {
  let day = 0;
  let failNext = false;
  const sandboxes = fakeSandboxes({
    "build.py": (files) => {
      files.set("/vercel/drive/option-flow/2026-10-07.csv", Buffer.from("ticker,calls,puts\nMU,200,100"));
      files.set("/vercel/job/outputs/option-flow.png", Buffer.from("chart day 0"));
      return { stdout: "built" };
    },
    "run.sh": (files) => {
      if (failNext) {
        failNext = false;
        return { exitCode: 1, stderr: "flow API returned 503" };
      }
      day++;
      files.set(`/vercel/drive/option-flow/day-${day}.csv`, Buffer.from(`day ${day}`));
      files.set("/vercel/job/outputs/option-flow.png", Buffer.from(`chart day ${day}`));
      files.set("/vercel/job/outputs/scratch.csv", Buffer.from(`scratch ${day}`));
      return { stdout: `pulled flow\nSUMMARY: Calls led puts 2:1 on day ${day}.\n` };
    },
  });
  return { sandboxes, failNextRun: () => (failNext = true) };
}

/** Collects started runs so a test can wait for them; models that must not be called throw. */
function captureRuns(steps: Step[] = [new Error("The model shouldn't be called for a replay.")]) {
  const runs: Promise<void>[] = [];
  setScheduler((work) => runs.push(work()), { model: scriptedModel(steps), research: false });
  return { settle: async () => void (await Promise.all(runs)) };
}

const run = (taskId: string, agentId: string, steps: Step[]) =>
  runAgentOnTask(ORG, taskId, agentId, { model: scriptedModel(steps), research: false });

describe("recurring jobs and the company drive", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("replays run.sh on schedule in the same sandbox, versions the chart and fills the drive", async () => {
    const { analyst, task } = await setUp();
    const { sandboxes, failNextRun } = flowSandboxes();
    setSandboxProvider(sandboxes.provider);
    const name = `mach-task-${task.id}`;

    // The first run: the agent builds the pipeline, attaches the chart and sets the schedule.
    await run(task.id, analyst.id, [
      [["write_file", { path: "run.sh", content: "python3 code/build.py" }]],
      [["run_code", { filename: "build.py", language: "python", code: "..." }]],
      [["attach_file", { path: "outputs/option-flow.png" }]],
      [["set_schedule", { cron: "0 16 * * 1-5", timezone: "Europe/London", mode: "script" }]],
      [["finish", { summary: "Calls led puts 2:1. Chart attached; it repeats weekdays at 16:00.", report: "Done." }]],
    ]);
    const schedule = (await getSchedule(task.id))!;
    expect(schedule).toMatchObject({ mode: "script", description: "At 16:00, Monday through Friday (Europe/London)" });
    expect((await listDrive(ORG)).map((f) => [f.path, f.taskNumber])).toEqual([["option-flow/2026-10-07.csv", task.number]]);

    // Someone marks it done; the schedule fires anyway: run.sh is replayed without a model.
    await updateTask(ORG, task.id, { status: "done" });
    let runs = captureRuns();
    expect(await fireDueSchedules(new Date(schedule.nextRunAt!.getTime() + 1000))).toBe(1);
    await runs.settle();

    expect(sandboxes.log.filter((l) => l.startsWith("create"))).toEqual([`create ${name}`]);
    const [chart] = await listTaskFiles(ORG, task.id);
    expect(chart.name).toBe("option-flow.png");
    expect(chart.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(chart.versions[0].note).toMatch(/^Scheduled run, \w{3} \d+ \w{3}, 16:00$/);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", summary: "Calls led puts 2:1 on day 1.", runStartedAt: null });
    const thread = (await listMessages(task.id)).slice(-2);
    expect(thread[0]).toMatchObject({ author: "Schedule", kind: "event" });
    expect(thread[0].body).toMatch(/^Scheduled run, .*: replaying run\.sh\.$/);
    expect(thread[1]).toMatchObject({ author: "Analyst", kind: "result" });
    expect(thread[1].body).toContain("Updated option-flow.png (v2).");
    expect(thread[1].body).toContain("Also wrote scratch.csv in outputs/ (not attached).");
    expect(thread[1].body).toContain("Saved to the drive: option-flow/day-1.csv.");
    expect((await readDriveFile(ORG, "option-flow/day-1.csv"))?.bytes.toString()).toBe("day 1");

    // The feed is down next time: the agent is woken with the log to sort it out.
    failNextRun();
    runs = captureRuns([[["finish", { summary: "The flow API was down at 16:00; reran at 16:20 and it worked.", report: "Fixed." }]]]);
    await rerunScript(ORG, task.id, { name: "Ahmed" });
    await runs.settle();
    const failure = (await listMessages(task.id)).find((m) => m.author === "Schedule" && m.kind === "update")!;
    expect(failure.body).toContain("run.sh failed");
    expect(failure.body).toContain("flow API returned 503");
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", summary: expect.stringMatching(/API was down/) });
  });

  it("shares drive files with other jobs and drops what was deleted", async () => {
    const { ahmed, analyst, task } = await setUp();
    const { sandboxes } = flowSandboxes();
    setSandboxProvider(sandboxes.provider);
    await run(task.id, analyst.id, [
      [["run_code", { filename: "build.py", language: "python", code: "..." }]],
      [["finish", { summary: "Saved today's flow.", report: "Done." }]],
    ]);

    const backtest = await createTask(ORG, { title: "Backtest on the flow history", people: [ahmed.id], agents: [analyst.id] });
    const other = `mach-task-${backtest.id}`;
    const look: Step[] = [[["list_files", { folder: "drive" }]], [["finish", { summary: "Read the history.", report: "Done." }]]];
    await run(backtest.id, analyst.id, look);
    expect(sandboxes.file(other, "/vercel/drive/option-flow/2026-10-07.csv")?.toString()).toContain("MU,200,100");

    await deleteDriveFile(ORG, "option-flow/");
    await run(backtest.id, analyst.id, look);
    expect(sandboxes.file(other, "/vercel/drive/option-flow/2026-10-07.csv")).toBeUndefined();
    expect(await listDrive(ORG)).toEqual([]);
  });
});
