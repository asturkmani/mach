"use server";

import { refresh } from "next/cache";

import { searchTasks as search, updateTask, type Priority, type Task, type TaskStatus } from "@/lib/tasks";
import { PRIORITIES, TASK_STATUSES } from "@/lib/task-words";
import { requireAppContext } from "@/lib/session";
import { attachToTask, detachFromTask } from "@/lib/files";
import {
  addToTask,
  approveOrDone,
  archiveTask,
  unarchiveTask,
  createTaskWithTeam,
  pauseTaskSchedule,
  pickOption,
  replyToTask,
  rerunScript,
  runNow,
  scheduleTask,
  setStatus,
  unscheduleTask,
  WorkError,
  type Actor,
} from "@/lib/work";
import { addMessage, getTask, removeMember } from "@/lib/tasks";

// Everything the task screens do. Each returns an error message for the person
// rather than throwing, and refreshes the page data on success.

export type TaskSnapshot = { status: TaskStatus; priority: Priority; laterUntil: string | null };
export type TaskActionResult = { error?: string; number?: number; snapshot?: TaskSnapshot };

async function actor(): Promise<{ organizationId: string; by: Actor }> {
  const { organization, person } = await requireAppContext();
  return { organizationId: organization.id, by: { name: person.name, personId: person.id } };
}

const snapshot = (task: Task): TaskSnapshot => ({
  status: task.status,
  priority: task.priority,
  laterUntil: task.laterUntil ? new Date(task.laterUntil).toISOString() : null,
});

async function attempt(work: () => Promise<TaskActionResult | void>): Promise<TaskActionResult> {
  try {
    const result = (await work()) ?? {};
    refresh();
    return result;
  } catch (error) {
    if (error instanceof WorkError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Try again." };
  }
}

export async function createTaskAction(input: {
  title: string;
  description?: string;
  priority?: Priority;
  personIds?: string[];
  agentIds?: string[];
  workerRole?: string | null;
}): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  if (!input.title.trim()) return { error: "Give the task a title." };
  return attempt(async () => {
    const task = await createTaskWithTeam(organizationId, {
      title: input.title,
      description: input.description,
      priority: input.priority && PRIORITIES.includes(input.priority) ? input.priority : "medium",
      personIds: input.personIds,
      agentIds: input.agentIds,
      workerRole: input.workerRole ?? undefined,
      by,
    });
    return { number: task.number };
  });
}

export async function replyAction(taskId: string, text: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await replyToTask(organizationId, taskId, by, text);
  });
}

export async function pickOptionAction(taskId: string, index: number): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await pickOption(organizationId, taskId, by, index);
  });
}

/** E: takes the recommended option, or marks the task done. Returns what to restore on undo. */
export async function approveOrDoneAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    const before = await getTask(organizationId, taskId);
    if (!before) throw new WorkError("That task no longer exists.");
    const tookOption = before.options.some((o) => o.recommended);
    await approveOrDone(organizationId, taskId, by);
    // Picking an option starts work, which can't be undone; marking done can.
    return tookOption ? {} : { snapshot: snapshot(before) };
  });
}

export async function setStatusAction(taskId: string, status: TaskStatus): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  if (!TASK_STATUSES.includes(status)) return { error: "Unknown status." };
  return attempt(async () => {
    const before = await getTask(organizationId, taskId);
    if (!before) throw new WorkError("That task no longer exists.");
    await setStatus(organizationId, taskId, status, by);
    return { snapshot: snapshot(before) };
  });
}

export async function setPriorityAction(taskId: string, priority: Priority): Promise<TaskActionResult> {
  const { organizationId } = await actor();
  if (!PRIORITIES.includes(priority)) return { error: "Unknown priority." };
  return attempt(async () => {
    const before = await getTask(organizationId, taskId);
    if (!before) throw new WorkError("That task no longer exists.");
    await updateTask(organizationId, taskId, { priority });
    return { snapshot: snapshot(before) };
  });
}

/** Puts a task off until a time (ISO string), or brings it back with null. */
export async function laterAction(taskId: string, until: string | null): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  const date = until ? new Date(until) : null;
  if (date && Number.isNaN(date.getTime())) return { error: "That time doesn't look right." };
  return attempt(async () => {
    const before = await getTask(organizationId, taskId);
    if (!before) throw new WorkError("That task no longer exists.");
    await updateTask(organizationId, taskId, { laterUntil: date });
    if (date) {
      await addMessage(taskId, {
        author: by.name,
        personId: by.personId,
        kind: "event",
        body: `Put this off until ${date.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      });
    }
    return { snapshot: snapshot(before) };
  });
}

/** Z: puts status, priority and "later" back to how they were. */
export async function restoreAction(taskId: string, previous: TaskSnapshot): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    const task = await getTask(organizationId, taskId);
    if (!task) throw new WorkError("That task no longer exists.");
    if (task.status !== previous.status) await setStatus(organizationId, taskId, previous.status, by, "Undid the last change.");
    await updateTask(organizationId, taskId, {
      priority: previous.priority,
      laterUntil: previous.laterUntil ? new Date(previous.laterUntil) : null,
    });
  });
}

export async function updateTaskTextAction(
  taskId: string,
  patch: { title?: string; description?: string; context?: string; progress?: string },
): Promise<TaskActionResult> {
  const { organizationId } = await actor();
  return attempt(async () => {
    if (patch.title !== undefined && !patch.title.trim()) throw new WorkError("A task needs a title.");
    await updateTask(organizationId, taskId, patch);
  });
}

export async function addMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string; workerRole?: string },
): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await addToTask(organizationId, taskId, by, member);
  });
}

export async function removeMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string },
): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    const task = await getTask(organizationId, taskId);
    if (!task) throw new WorkError("That task no longer exists.");
    const leaving = task.members.find((m) => m.id === (member.personId ?? member.agentId));
    await removeMember(taskId, member);
    if (leaving) {
      await addMessage(taskId, { author: by.name, personId: by.personId, kind: "event", body: `Took ${leaving.name} off this task.` });
    }
  });
}

export async function runAgentAction(taskId: string, agentId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await runNow(organizationId, taskId, agentId, by);
  });
}

export type TaskHit = { id: string; number: number; title: string; status: TaskStatus };

export async function searchTasksAction(query: string): Promise<TaskHit[]> {
  const { organization } = await requireAppContext();
  const tasks = await search(organization.id, query, 12);
  return tasks.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status }));
}

export async function archiveAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await archiveTask(organizationId, taskId, by);
  });
}

export async function unarchiveAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await unarchiveTask(organizationId, taskId, by);
  });
}

/** Attaches a company file to a job as an input. */
export async function attachFileAction(taskId: string, fileId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    const task = await getTask(organizationId, taskId);
    if (!task) throw new WorkError("That task no longer exists.");
    try {
      await attachToTask(organizationId, taskId, fileId, "input");
    } catch (error) {
      throw new WorkError(error instanceof Error ? error.message : "Couldn't attach that file.");
    }
    await addMessage(taskId, { author: by.name, personId: by.personId, kind: "event", body: "Attached a file from the library." });
  });
}

export async function detachFileAction(taskId: string, fileId: string): Promise<TaskActionResult> {
  const { organizationId } = await actor();
  return attempt(async () => {
    const task = await getTask(organizationId, taskId);
    if (!task) throw new WorkError("That task no longer exists.");
    await detachFromTask(taskId, fileId);
  });
}

/** Makes a job repeat, or changes its schedule. */
export async function setScheduleAction(
  taskId: string,
  input: { cron: string; timezone: string; mode: "script" | "agent" },
): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  if (input.mode !== "script" && input.mode !== "agent") return { error: "Pick how each run works." };
  return attempt(async () => {
    await scheduleTask(organizationId, taskId, by, input);
  });
}

export async function pauseScheduleAction(taskId: string, paused: boolean): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await pauseTaskSchedule(organizationId, taskId, by, paused);
  });
}

export async function removeScheduleAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await unscheduleTask(organizationId, taskId, by);
  });
}

/** Replays the job's run.sh now. */
export async function rerunAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actor();
  return attempt(async () => {
    await rerunScript(organizationId, taskId, by);
  });
}
