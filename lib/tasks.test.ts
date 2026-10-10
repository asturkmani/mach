import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { createAgent, listAgents, workerAgent } from "@/lib/agents/store";
import { createOrganization } from "@/lib/orgs";
import { linkMember, savePerson } from "@/lib/people";
import {
  addMember,
  addMessage,
  claimRun,
  countInbox,
  createTask,
  getTaskByNumber,
  listInbox,
  listInProgress,
  listMessages,
  listTasks,
  releaseRun,
  searchTasks,
  updateTask,
} from "@/lib/tasks";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const lina = await savePerson(ORG, { name: "Lina", role: "Analyst" });
  return { ahmed, lina };
}

describe("tasks", () => {
  let pg: PGlite;
  beforeEach(async () => {
    pg = await useTestDb();
  });

  it("numbers tasks per organization and keeps people and agents on them", async () => {
    const { ahmed, lina } = await setUp();
    const analyst = await createAgent(ORG, { name: "Analyst", role: "Financial analysis" });
    const first = await createTask(ORG, { title: "Review Q3", people: [ahmed.id, lina.id], agents: [analyst.id] });
    const second = await createTask(ORG, { title: "Book flights", people: [ahmed.id] });

    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first.members.map((m) => [m.type, m.name])).toEqual([
      ["person", "Ahmed"],
      ["person", "Lina"],
      ["agent", "Analyst"],
    ]);
    expect((await getTaskByNumber(ORG, 2))?.title).toBe("Book flights");

    await addMember(second.id, { agentId: analyst.id });
    await addMember(second.id, { agentId: analyst.id });
    expect((await getTaskByNumber(ORG, 2))?.members).toHaveLength(2);
  });

  it("puts a task in your inbox only when it waits on a person", async () => {
    const { ahmed, lina } = await setUp();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const agentTask = await createTask(ORG, { title: "Model Q4", people: [ahmed.id], agents: [analyst.id] });
    const humanTask = await createTask(ORG, { title: "Call the bank", people: [ahmed.id], priority: "urgent" });
    await createTask(ORG, { title: "Lina's job", people: [lina.id] });

    // The agent is on it, so it isn't waiting on Ahmed yet; the human task is.
    expect((await listInbox(ORG, ahmed.id)).map((t) => t.title)).toEqual(["Call the bank"]);
    expect((await listInProgress(ORG, ahmed.id)).map((t) => t.title)).toEqual(["Model Q4"]);

    await updateTask(ORG, agentTask.id, { status: "review", summary: "Model done. Send it?" });
    expect((await listInbox(ORG, ahmed.id)).map((t) => t.title)).toEqual(["Call the bank", "Model Q4"]);
    expect(await countInbox(ORG, ahmed.id)).toBe(2);

    // Put off until tomorrow: out of the inbox, into In progress.
    await updateTask(ORG, humanTask.id, { laterUntil: new Date(Date.now() + 86_400_000) });
    expect((await listInbox(ORG, ahmed.id)).map((t) => t.title)).toEqual(["Model Q4"]);

    await updateTask(ORG, agentTask.id, { status: "done" });
    expect(await countInbox(ORG, ahmed.id)).toBe(0);
    expect((await getTaskByNumber(ORG, agentTask.number))?.closedAt).toBeInstanceOf(Date);
  });

  it("lets only one run hold a task", async () => {
    const { ahmed } = await setUp();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const task = await createTask(ORG, { title: "Model Q4", people: [ahmed.id], agents: [analyst.id] });

    expect(await claimRun(ORG, task.id, analyst.id)).toBe(true);
    expect(await claimRun(ORG, task.id, analyst.id)).toBe(false);
    const running = await getTaskByNumber(ORG, task.number);
    expect(running).toMatchObject({ status: "in_progress", runAgentId: analyst.id, agentTurns: 1 });

    await releaseRun(task.id, analyst.id);
    expect(await claimRun(ORG, task.id, analyst.id)).toBe(true);
  });

  it("records how long a run took on the agent's result, and only there", async () => {
    const { ahmed } = await setUp();
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const task = await createTask(ORG, { title: "Model Q4", people: [ahmed.id], agents: [analyst.id] });
    await claimRun(ORG, task.id, analyst.id);
    await pg.query("update tasks set run_began_at = now() - interval '252 seconds' where id = $1", [task.id]);

    await addMessage(task.id, { author: "Analyst", agentId: analyst.id, kind: "update", body: "Halfway." });
    await addMessage(task.id, { author: "Analyst", agentId: analyst.id, kind: "result", body: "Done." });
    await addMessage(task.id, { author: "Ahmed", personId: ahmed.id, kind: "result", body: "Not a run." });

    const [update, result, byPerson] = await listMessages(task.id);
    expect(update.durationMs).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(252_000);
    expect(result.durationMs).toBeLessThan(262_000);
    expect(byPerson.durationMs).toBeNull();
  });

  it("keeps a thread, searches and lists open work first", async () => {
    const { ahmed } = await setUp();
    const task = await createTask(ORG, { title: "Micron earnings review", people: [ahmed.id] });
    await createTask(ORG, { title: "Old job", people: [ahmed.id], status: "done" });
    await addMessage(task.id, { author: "Ahmed", personId: ahmed.id, body: "Use the latest 10-Q." });
    await addMessage(task.id, { author: "Ahmed", body: "   " });

    expect((await listMessages(task.id)).map((m) => [m.author, m.kind, m.body])).toEqual([
      ["Ahmed", "comment", "Use the latest 10-Q."],
    ]);
    expect((await searchTasks(ORG, "micron")).map((t) => t.number)).toEqual([1]);
    expect((await searchTasks(ORG, "#2")).map((t) => t.title)).toEqual(["Old job"]);
    expect((await listTasks(ORG)).map((t) => t.title)).toEqual(["Micron earnings review", "Old job"]);
  });
});

describe("agents", () => {
  beforeEach(async () => {
    await useTestDb();
  });

  it("keeps names unique, and makes the one Worker once, around a name already taken", async () => {
    await setUp();
    await createAgent(ORG, { name: "Sales", role: "Outbound sales" });
    await expect(createAgent(ORG, { name: "sales" })).rejects.toThrow(/already an agent/);

    // A worker agent from before, made for one task, already has the name.
    await createAgent(ORG, { kind: "worker", name: "Worker" });
    const worker = await workerAgent(ORG);
    expect(worker.name).toBe("Worker 2");
    expect((await workerAgent(ORG)).id).toBe(worker.id);
    expect((await listAgents(ORG)).map((a) => [a.kind, a.name])).toEqual([
      ["defined", "Sales"],
      ["defined", "Worker 2"],
      ["worker", "Worker"],
    ]);
  });
});
