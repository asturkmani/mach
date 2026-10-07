import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent } from "@/lib/agents/store";
import { createOrganization } from "@/lib/orgs";
import { linkMember, savePerson } from "@/lib/people";
import { addMessage, getTask, listMessages } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { addToTask, archiveTask, createTaskWithTeam, replyToTask, setStatus, unarchiveTask } from "@/lib/work";
import { createWorker, getAgent } from "@/lib/agents/store";
import { setSandboxProvider } from "@/lib/sandbox";
import { listInbox, setSandboxName } from "@/lib/tasks";
import { fakeSandboxes } from "@/test/fake-sandbox";

const ORG = "org_cedar";
const OTHER = "org_other";

async function seed() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  await createOrganization({ id: OTHER, name: "Other Co" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const outsider = await savePerson(OTHER, { name: "Mallory" });
  const foreignAgent = await createAgent(OTHER, { name: "Spy" });
  return { ahmed, by: { name: "Ahmed", personId: ahmed.id }, outsider, foreignAgent };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Finishes every run; on its first run, a person replies while the agent is still working. */
function modelWithMidRunReply(taskId: () => string, ahmedId: string) {
  let calls = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      if (calls === 1) await addMessage(taskId(), { author: "Ahmed", personId: ahmedId, body: "Also cover Nvidia." });
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: String(calls),
            toolName: "finish",
            input: JSON.stringify({ summary: `Run ${calls} done.`, report: `Report ${calls}.` }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

describe("work on tasks", () => {
  beforeEach(async () => {
    setScheduler(null);
    await useTestDb();
  });

  it("only puts people and agents from the same company on a task", async () => {
    const { by, outsider, foreignAgent } = await seed();
    const task = await createTaskWithTeam(ORG, {
      title: "Quarterly report",
      personIds: [outsider.id],
      agentIds: [foreignAgent.id],
      by,
    });
    expect(task.members.map((m) => m.name)).toEqual(["Ahmed"]);

    await expect(addToTask(ORG, task.id, by, { personId: outsider.id })).rejects.toThrow(/isn't in this company/);
    await expect(addToTask(ORG, task.id, by, { agentId: foreignAgent.id })).rejects.toThrow(/isn't in this company/);
    const lina = await savePerson(ORG, { name: "Lina" });
    expect((await addToTask(ORG, task.id, by, { personId: lina.id })).members.map((m) => m.name)).toEqual(["Ahmed", "Lina"]);
  });

  it("runs the agent again when someone replies while it's working", async () => {
    const { ahmed, by } = await seed();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    let taskId = "";
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), {
      model: modelWithMidRunReply(() => taskId, ahmed.id),
      research: false,
    });

    const task = await createTaskWithTeam(ORG, { title: "Review Micron", agentIds: [analyst.id], by });
    taskId = task.id;
    await Promise.all(runs);

    expect((await getTask(ORG, task.id))!.summary).toBe("Run 2 done.");
    expect((await listMessages(task.id)).filter((m) => m.kind === "result").map((m) => m.body)).toEqual([
      "Report 1.",
      "Report 2.",
    ]);
  });

  it("hands a reply to the agent, which picks the task back up", async () => {
    const { by } = await seed();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const scheduled: (() => Promise<void>)[] = [];
    setScheduler((work) => scheduled.push(work));
    const task = await createTaskWithTeam(ORG, { title: "Review Micron", agentIds: [analyst.id], by });
    expect(scheduled).toHaveLength(1);

    await replyToTask(ORG, task.id, by, "Use the latest 10-Q.");
    expect(scheduled).toHaveLength(2);
    expect((await getTask(ORG, task.id))!.status).toBe("ready");
  });

  it("keeps a done job's sandbox and agents, and retires them only when it's archived", async () => {
    const { ahmed, by } = await seed();
    const worker = await createWorker(ORG, "Research");
    const scheduled: (() => Promise<void>)[] = [];
    setScheduler((work) => scheduled.push(work));
    const task = await createTaskWithTeam(ORG, { title: "Backtest rules ABC", agentIds: [worker.id], by });
    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    await sandboxes.provider.open(`mach-task-${task.id}`, async () => {});
    await setSandboxName(task.id, `mach-task-${task.id}`);

    await setStatus(ORG, task.id, "done", by);
    expect((await getAgent(ORG, worker.id))!.status).toBe("active");
    expect(sandboxes.machines.size).toBe(1);

    // Replying on a done job reopens it for the same agent.
    await replyToTask(ORG, task.id, by, "Try rules ABD");
    expect((await getTask(ORG, task.id))!.status).toBe("ready");

    await archiveTask(ORG, task.id, by);
    expect((await getAgent(ORG, worker.id))!.status).toBe("archived");
    expect(sandboxes.log).toContain(`delete mach-task-${task.id}`);
    expect(await getTask(ORG, task.id)).toMatchObject({ sandboxName: null, archivedAt: expect.any(Date) });
    expect(await listInbox(ORG, ahmed.id)).toEqual([]);

    await unarchiveTask(ORG, task.id, by);
    expect((await getAgent(ORG, worker.id))!.status).toBe("active");
    expect((await getTask(ORG, task.id))!.archivedAt).toBeNull();
    setSandboxProvider(null);
  });
});
