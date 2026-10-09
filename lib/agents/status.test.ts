import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { activityFor } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask, getTask, listMessages, listWorking } from "@/lib/tasks";
import { replyToTask } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const analyst = await createAgent(ORG, { name: "Analyst" });
  const task = await createTask(ORG, { title: "Summarise today's positions", people: [ahmed.id], agents: [analyst.id] });
  return { analyst, task, by: { name: "Ahmed", personId: ahmed.id } };
}

/** A scripted model that, before each call, notes what the task's live status says (and can do more). */
function watchingModel(taskId: string, steps: Step[], before?: (call: number) => Promise<void>) {
  const inner = scriptedModel(steps);
  const statuses: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      await before?.(++call);
      statuses.push((await getTask(ORG, taskId))!.runActivity);
      return inner.doGenerate(options);
    },
  });
  return { model, statuses };
}

const reactionsOn = async (taskId: string, body: string) =>
  (await listMessages(taskId)).find((m) => m.body === body)!.reactions.map((r) => `${r.emoji} ${r.agentName}`);

describe("an agent's live status on a task", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("reacts 👀 to a reply straight away, shows what it's doing while it works, then ✅ when it's done", async () => {
    const { task, by } = await setUp();
    const during: string[] = [];
    const sandboxes = fakeSandboxes({
      "summarise.py": () => void getTask(ORG, task.id).then((t) => during.push(t!.runActivity)),
    });
    setSandboxProvider(sandboxes.provider);
    const { model, statuses } = watchingModel(task.id, [
      [["run_code", { filename: "summarise.py", language: "python", code: "print('MU 1.2m')" }]],
      [["finish", { summary: "MU is the largest position.", report: "Done." }]],
    ]);

    // The run is queued, not started: the reply already has the agent's 👀.
    const queued: (() => Promise<void>)[] = [];
    setScheduler((work) => queued.push(work), { research: false, model });
    await replyToTask(ORG, task.id, by, "Which position is largest today?");
    expect(await reactionsOn(task.id, "Which position is largest today?")).toEqual(["👀 Analyst"]);

    await Promise.all(queued.map((work) => work()));
    // Thinking before each model call, the script's name while it ran.
    expect(statuses).toEqual(["Thinking", "Thinking"]);
    expect(during).toEqual(["Running summarise.py"]);
    expect(await reactionsOn(task.id, "Which position is largest today?")).toEqual(["✅ Analyst"]);
    const done = (await getTask(ORG, task.id))!;
    expect(done).toMatchObject({ status: "review", runActivity: "", runBeganAt: null });
    expect(await listWorking(ORG)).toEqual([]);
  });

  it("lists the runs going now, and marks a question with 💬", async () => {
    const { task, by } = await setUp();
    const working: Awaited<ReturnType<typeof listWorking>>[] = [];
    const { model } = watchingModel(task.id, [[["ask", { summary: "Which valuation date should I use?", question: "As of which date?" }]]], async () => {
      working.push(await listWorking(ORG));
    });
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), { research: false, model });
    await replyToTask(ORG, task.id, by, "Value the portfolio");
    await Promise.all(runs);

    expect(working[0]).toEqual([{ number: task.number, title: task.title, agent: "Analyst", activity: "Thinking", since: expect.any(Date) }]);
    expect(await reactionsOn(task.id, "Value the portfolio")).toEqual(["💬 Analyst"]);
  });

  it("marks a reply that came mid-run as queued (⏳) until the run that reads it is done", async () => {
    const { task, by } = await setUp();
    const runs: Promise<void>[] = [];
    const seenMidRun: string[][] = [];
    const { model } = watchingModel(
      task.id,
      [
        [["post_update", { message: "Pulling positions." }]],
        [["finish", { summary: "Summarised.", report: "Done." }]],
      ],
      async (call) => {
        if (call !== 2) return;
        await replyToTask(ORG, task.id, by, "Also include cash, please.");
        seenMidRun.push(await reactionsOn(task.id, "Also include cash, please."));
      },
    );
    setScheduler((work) => runs.push(work()), { research: false, model });
    await replyToTask(ORG, task.id, by, "Summarise the positions");
    // The chain goes again for the mid-run reply; wait for everything it started.
    for (let settled = 0; settled < runs.length; settled = runs.length) await Promise.all(runs);

    expect(seenMidRun).toEqual([["⏳ Analyst"]]);
    expect(await reactionsOn(task.id, "Summarise the positions")).toEqual(["✅ Analyst"]);
    expect(await reactionsOn(task.id, "Also include cash, please.")).toEqual(["✅ Analyst"]);
  });

  it("says what each tool is doing in a few words", () => {
    expect(activityFor("run_code", { filename: "build_model.py" })).toBe("Running build_model.py");
    expect(activityFor("run_command", { command: "pip install yfinance && python code/fetch.py --all-the-flags --and-more" })).toBe(
      "Running pip install yfinance && python code/fetch.py --…",
    );
    expect(activityFor("attach_file", { path: "outputs/portfolio-model.xlsx" })).toBe("Attaching portfolio-model.xlsx");
    expect(activityFor("call_api", { integration: "masttro" })).toBe("Calling masttro");
    expect(activityFor("browser_login", { login: "masttro-web" })).toBe("Signing in to masttro-web");
    expect(activityFor("finish", {})).toBe("Writing the report");
    expect(activityFor("something_new", {})).toBe("Something new");
  });
});
