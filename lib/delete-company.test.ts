import { beforeEach, describe, expect, it, vi } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { getOrCreateChat } from "@/lib/chats";
import { getDb } from "@/lib/db";
import { deleteCompany } from "@/lib/delete-company";
import { writeDriveFile } from "@/lib/drive";
import { saveVersion } from "@/lib/files";
import { saveCredentials, saveIntegration } from "@/lib/integrations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider, workspaceSandboxName } from "@/lib/sandbox";
import { saveSchedule } from "@/lib/schedules";
import { createTask } from "@/lib/tasks";
import { replyToTask } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

/** A company with one of everything: people, chat, agent, a job with a sandbox, files, the drive, an integration, a schedule. */
async function companyWithEverything(id: string) {
  await createOrganization({ id, name: `Company ${id}` });
  const person = await linkMember(id, { id: `user_${id}`, email: `ahmed@${id}.example`, name: "Ahmed" });
  await getOrCreateChat(id, `user_${id}`);
  const analyst = await createAgent(id, { name: "Analyst" });
  const task = await createTask(id, { title: "Model the portfolio", people: [person.id], agents: [analyst.id] });
  await runAgentOnTask(id, task.id, analyst.id, {
    research: false,
    model: scriptedModel([
      [["run_code", { filename: "model.py", language: "python", code: "print(1)" }]],
      [["finish", { summary: "Done.", report: "Done." }]],
    ]),
  });
  await replyToTask(id, task.id, { name: "Ahmed", personId: person.id }, "Thanks", [{ name: "notes.csv", bytes: Buffer.from("a,b\n") }]);
  await saveVersion(id, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("xlsx"), taskId: task.id, agentId: analyst.id });
  await writeDriveFile(id, { path: "prices/mu.csv", bytes: Buffer.from("date,close\n") });
  const source = await saveIntegration(id, {
    kind: "api",
    name: "Masttro",
    config: { baseUrl: "https://api.masttro.example", domains: [], fields: [{ name: "apiKey", label: "API key" }], headers: { "X-Key": "{{apiKey}}" } },
  });
  await saveCredentials(id, source.id, { apiKey: "secret-key" });
  await saveSchedule(task.id, { cron: "0 9 * * 1-5", timezone: "Europe/London" });
  return task;
}

const TABLES = [
  "company_profiles",
  "people",
  "chats",
  "agents",
  "tasks",
  "files",
  "drive_files",
  "integrations",
] as const;

async function rowsFor(organizationId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await getDb().query<{ n: number }>(`select count(*)::int as n from ${table} where organization_id = $1`, [organizationId]);
    counts[table] = row.n;
  }
  // What hangs off tasks and files, which have no organization column of their own.
  const [orphans] = await getDb().query<{ n: number }>(
    `select (select count(*) from task_messages m where not exists (select 1 from tasks t where t.id = m.task_id))
          + (select count(*) from file_versions v where not exists (select 1 from files f where f.id = v.file_id))
          + (select count(*) from task_schedules s where not exists (select 1 from tasks t where t.id = s.task_id)) as n`,
  );
  counts.orphans = Number(orphans.n);
  return counts;
}

describe("deleting a company", () => {
  beforeEach(async () => {
    setScheduler(() => undefined);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("removes its sandboxes, every record and its WorkOS organization, and leaves other companies alone", async () => {
    const sandboxes = fakeSandboxes({ "model.py": () => ({ stdout: "1" }) });
    setSandboxProvider(sandboxes.provider);
    const task = await companyWithEverything("org_cedar");
    await companyWithEverything("org_oak");
    expect(Object.values(await rowsFor("org_cedar")).some((n) => n > 0)).toBe(true);

    const removeFromWorkOS = vi.fn(async () => undefined);
    const result = await deleteCompany("org_cedar", { removeFromWorkOS });

    expect(result.problems).toEqual([]);
    expect(await getOrganization("org_cedar")).toBeNull();
    expect(await rowsFor("org_cedar")).toEqual({ ...Object.fromEntries(TABLES.map((t) => [t, 0])), orphans: 0 });
    expect(sandboxes.log).toContain(`delete mach-task-${task.id}`);
    expect(sandboxes.log).toContain(`delete ${workspaceSandboxName("org_cedar")}`);
    expect(sandboxes.machines.has(`mach-task-${task.id}`)).toBe(false);
    expect(removeFromWorkOS).toHaveBeenCalledWith("org_cedar");

    // The other company still has all of it.
    expect(await getOrganization("org_oak")).not.toBeNull();
    expect(Object.values(await rowsFor("org_oak")).every((n, i, all) => i === all.length - 1 || n > 0)).toBe(true);
  });

  it("stops an agent run that's still going from bringing a sandbox back", async () => {
    const sandboxes = fakeSandboxes({ "model.py": () => ({ stdout: "1" }) });
    setSandboxProvider(sandboxes.provider);
    await createOrganization({ id: "org_cedar", name: "Cedar" });
    const analyst = await createAgent("org_cedar", { name: "Analyst" });
    const task = await createTask("org_cedar", { title: "Model it", agents: [analyst.id] });
    // The company goes while the agent is between steps.
    const model = scriptedModel([
      [["run_code", { filename: "model.py", language: "python", code: "print(1)" }]],
      [["finish", { summary: "Done.", report: "Done." }]],
    ]);
    const deleting = vi.fn(async () => undefined);
    const run = runAgentOnTask("org_cedar", task.id, analyst.id, { research: false, model });
    await deleteCompany("org_cedar", { removeFromWorkOS: deleting });
    await run.catch(() => undefined);
    expect(sandboxes.machines.size).toBe(0);
  });

  it("reports a WorkOS failure without undoing the delete", async () => {
    setSandboxProvider(fakeSandboxes().provider);
    await createOrganization({ id: "org_cedar", name: "Cedar" });
    const result = await deleteCompany("org_cedar", {
      removeFromWorkOS: async () => {
        throw new Error("WorkOS is down");
      },
    });
    expect(await getOrganization("org_cedar")).toBeNull();
    expect(result.problems).toEqual(["WorkOS organization: WorkOS is down"]);
  });
});
