import "server-only";

import type { Agent } from "@/lib/agents/store";
import { getDb } from "@/lib/db";
import { schedulesFor, type Schedule } from "@/lib/schedules";
import { isRunning, listScheduledTasks, type Task } from "@/lib/tasks";

// The company's work at a glance, for the Chief of Staff: every open task
// with what's happening on it right now, every agent and what it's on, and
// the jobs that run on a schedule.

export type ScheduledJob = {
  task: Task;
  schedule: Schedule;
  /** The page whose data it keeps fresh, if that's its job. */
  page: { slug: string; title: string } | null;
};

/** Every job that repeats on a schedule, with its schedule and the page it refreshes. */
export async function listScheduledJobs(organizationId: string): Promise<ScheduledJob[]> {
  const tasks = await listScheduledTasks(organizationId);
  if (tasks.length === 0) return [];
  const [schedules, pages] = await Promise.all([
    schedulesFor(tasks.map((t) => t.id)),
    getDb().query<{ task_id: string; slug: string; title: string }>(
      "select task_id, slug, title from pages where organization_id = $1 and task_id is not null",
      [organizationId],
    ),
  ]);
  return tasks.flatMap((task) => {
    const schedule = schedules.get(task.id);
    if (!schedule) return [];
    const page = pages.find((p) => p.task_id === task.id);
    return [{ task, schedule, page: page ? { slug: page.slug, title: page.title } : null }];
  });
}

/** "4m", "2h 5m", "3d". */
export function elapsed(since: Date | string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(minutes / 1440)}d`;
}

const agentsOn = (task: Task) => task.members.filter((m) => m.type === "agent");

/** What's happening on a task right now, in a few words. */
export function taskState(task: Task, now = Date.now()): string {
  if (isRunning(task, now)) {
    const agent = agentsOn(task).find((a) => a.id === task.runAgentId)?.name ?? "An agent";
    return `${agent} is working on it${task.runBeganAt ? ` (${elapsed(task.runBeganAt, now)})` : ""}${task.runActivity ? `: ${task.runActivity}` : ""}`;
  }
  if (task.pendingLogin) return `waiting for a ${task.pendingLogin} sign-in code from people`;
  switch (task.status) {
    case "waiting":
      return "waiting on people";
    case "review":
      return "done by its agent, waiting for people to review";
    case "ready":
      return agentsOn(task).length ? "about to start" : "ready, no agent on it";
    case "in_progress":
      return "in progress";
    case "backlog":
      return task.laterUntil && new Date(task.laterUntil).getTime() > now ? "parked until later" : "in the backlog";
    default:
      return task.status;
  }
}

function taskLine(task: Task, now: number): string {
  const who = task.members.map((m) => m.name).join(", ") || "no one";
  const summary = task.summary || task.description.split("\n").find((l) => l.trim()) || "";
  return `- #${task.number} ${task.title} [${task.status}; ${taskState(task, now)}] · ${who}${summary ? `\n  ${summary.slice(0, 220)}` : ""}`;
}

function jobLine(job: ScheduledJob, now: number): string {
  const { task, schedule, page } = job;
  const last = schedule.lastRunAt ? `last ran ${elapsed(schedule.lastRunAt, now)} ago` : "hasn't run yet";
  const health =
    isRunning(task, now) ? taskState(task, now) : task.status === "waiting" || task.status === "review" ? "needs attention: its last run failed or asked something" : "fine";
  const fixer = agentsOn(task).map((a) => a.name).join(", ");
  return `- #${task.number} ${task.title}: ${schedule.paused ? "paused" : schedule.description}, ${
    schedule.mode === "script" ? "replays its script (an agent only if it breaks)" : "an agent does it each time"
  }; ${last}; ${health}${page ? `; keeps the "${page.title}" page fresh` : ""}${fixer ? `; agent: ${fixer}` : ""}`;
}

/** The Chief of Staff's live view of the company's work. */
export function workOverview(input: { openTasks: Task[]; agents: Agent[]; jobs: ScheduledJob[] }, now = Date.now()): string {
  const scheduled = new Set(input.jobs.map((j) => j.task.id));
  // Scheduled jobs have their own list, unless one needs people.
  const open = input.openTasks.filter(
    (t) => t.kind === "task" && (!scheduled.has(t.id) || t.status === "waiting" || t.status === "review"),
  );
  const shown = open.slice(0, 60);
  const onTasks = (agentId: string) =>
    open.filter((t) => t.members.some((m) => m.id === agentId)).map((t) => `#${t.number} (${isRunning(t, now) && t.runAgentId === agentId ? "working on it now" : taskState(t, now)})`);
  const active = input.agents.filter((a) => a.status !== "archived");
  const defined = active.filter((a) => a.kind === "defined");
  const workers = active.filter((a) => a.kind === "worker");
  const agentLine = (a: Agent) => {
    const on = onTasks(a.id);
    return `- ${a.name}${a.role ? ` (${a.role})` : ""}${a.status === "paused" ? " [paused]" : ""}: ${on.length ? on.join(", ") : "no open tasks"}`;
  };
  return [
    `Open tasks (${open.length}):`,
    shown.map((t) => taskLine(t, now)).join("\n") || "(none)",
    open.length > shown.length ? `…and ${open.length - shown.length} more: use find_tasks.` : "",
    "",
    "Defined agents and what they're on:",
    defined.map(agentLine).join("\n") || "(none yet)",
    "",
    "Worker agents (each made for one job):",
    workers
      .map((a) => {
        const job = input.jobs.find((j) => j.task.members.some((m) => m.id === a.id));
        return job ? `- ${a.name}: fixes scheduled job #${job.task.number} when it breaks` : agentLine(a);
      })
      .join("\n") || "(none)",
    "",
    "Scheduled jobs:",
    input.jobs.map((j) => jobLine(j, now)).join("\n") || "(none)",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
