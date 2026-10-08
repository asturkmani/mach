import "server-only";

import { listAgents } from "@/lib/agents/store";
import { listPeople } from "@/lib/people";
import type { MachSource } from "@/lib/mach-sources";
import { listTasks } from "@/lib/tasks";

// Mach's own data, which a page can read live, by name, alongside its drive
// files: no script or refresh job, since it's already in Mach's database and
// always current. "mach:" can't start a drive path, so the names never clash.
// What each holds is described in lib/mach-sources.ts.

/** At most this many done or cancelled tasks, newest first, besides every open one. */
const CLOSED_TASKS = 100;

export const MACH_SOURCES: Record<MachSource, { load: (organizationId: string) => Promise<unknown[]> }> = {
  "mach:tasks": {
    load: async (organizationId: string) =>
      (await listTasks(organizationId, { closedLimit: CLOSED_TASKS }))
        .filter((t) => t.kind === "task")
        .map((t) => ({
          number: t.number,
          title: t.title,
          status: t.status,
          priority: t.priority,
          summary: t.summary,
          people: t.members.filter((m) => m.type === "person").map((m) => m.name),
          agents: t.members.filter((m) => m.type === "agent").map((m) => m.name),
          repeats: t.repeats,
          running: Boolean(t.runStartedAt),
          activity: t.runStartedAt ? t.runActivity : "",
          laterUntil: t.laterUntil,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          closedAt: t.closedAt,
          url: `/tasks/${t.number}`,
        })),
  },
  "mach:people": {
    load: async (organizationId: string) =>
      (await listPeople(organizationId)).map((p) => ({
        name: p.name,
        role: p.role,
        responsibilities: p.responsibilities,
        reportsTo: p.managerName,
        status: p.status,
      })),
  },
  "mach:agents": {
    load: async (organizationId: string) =>
      (await listAgents(organizationId)).map((a) => ({
        name: a.name,
        role: a.role,
        kind: a.kind,
        status: a.status,
        description: a.description,
      })),
  },
};

export { isMachSource, type MachSource } from "@/lib/mach-sources";
