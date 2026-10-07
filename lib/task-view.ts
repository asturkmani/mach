import type { Priority, TaskStatus } from "@/lib/task-words";
import type { Task, TaskKind, TaskOption } from "@/lib/tasks";

// The part of a task that list screens need, in a shape that passes cleanly
// from server components to the browser.

export type TaskView = {
  id: string;
  number: number;
  kind: TaskKind;
  title: string;
  summary: string;
  status: TaskStatus;
  priority: Priority;
  options: TaskOption[];
  laterUntil: string | null;
  updatedAt: string;
  running: boolean;
  runAgent: string | null;
  /** While an agent works: what it's doing now ("Running summarise.py"), and since when the run began. */
  activity: string | null;
  runSince: string | null;
  /** A recurring job. */
  repeats: boolean;
  /** Who @-mentioned the viewer, when that's why it needs them. */
  mentionedBy: string | null;
  people: { id: string; name: string }[];
  agents: { id: string; name: string; kind: "defined" | "worker" }[];
};

const RUN_LEASE_MS = 15 * 60_000;

export function toView(task: Task, now = Date.now()): TaskView {
  const agents = task.members.filter((m) => m.type === "agent");
  const running = Boolean(task.runStartedAt && now - new Date(task.runStartedAt).getTime() < RUN_LEASE_MS);
  return {
    id: task.id,
    number: task.number,
    kind: task.kind,
    title: task.title,
    summary: task.summary || firstLine(task.description),
    status: task.status,
    priority: task.priority,
    options: task.options,
    laterUntil: task.laterUntil ? new Date(task.laterUntil).toISOString() : null,
    updatedAt: new Date(task.updatedAt).toISOString(),
    running,
    runAgent: running ? (agents.find((a) => a.id === task.runAgentId)?.name ?? null) : null,
    activity: running ? task.runActivity || null : null,
    runSince: running && task.runBeganAt ? new Date(task.runBeganAt).toISOString() : null,
    repeats: task.repeats,
    mentionedBy: task.mentionedBy ?? null,
    people: task.members.filter((m) => m.type === "person").map((m) => ({ id: m.id, name: m.name })),
    agents: agents.map((m) => ({ id: m.id, name: m.name, kind: m.type === "agent" ? m.kind : "worker" })),
  };
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
}

/** Who a row is from: the agents on it, else the people. */
export function byline(task: Pick<TaskView, "kind" | "agents" | "people">): string {
  if (task.kind === "suggestion") return "Chief of Staff";
  if (task.agents.length) return task.agents.map((a) => a.name).join(", ");
  return task.people.map((p) => p.name).join(", ");
}
