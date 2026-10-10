"use server";

import { refresh } from "next/cache";

import { searchTasks as search, updateTask, type Priority, type Task, type TaskStatus } from "@/lib/tasks";
import { PRIORITIES } from "@/lib/task-words";
import { performAs } from "@/lib/actions";
import { OperationError } from "@/lib/operations";
import { actorOf, requireAppContext } from "@/lib/session";
import { discardUploads, readUpload } from "@/lib/files";
import {
  approveOrDone,
  createTaskWithTeam,
  replyToTask,
  sendQueuedNow,
  setStatus,
  MAX_REPLY_ATTACHMENTS,
  WorkError,
  type Actor,
} from "@/lib/work";
import { canSeeTask, getTask, type TaskVisibility } from "@/lib/tasks";

// Everything the task screens do: the actions themselves are declared once in
// lib/actions/tasks.ts (so the Chief of Staff can do them too). Each returns an
// error message for the person rather than throwing, and refreshes the page
// data on success.

export type TaskSnapshot = { status: TaskStatus; priority: Priority; laterUntil: string | null };
export type TaskActionResult = { error?: string; number?: number; snapshot?: TaskSnapshot };

async function actor(): Promise<{ organizationId: string; by: Actor }> {
  const { organization, person } = await requireAppContext();
  return { organizationId: organization.id, by: { name: person.name, personId: person.id } };
}

/** The signed-in person, for an action on a task they may see; anything else is refused as if the task didn't exist. */
async function actorFor(taskId: string): Promise<{ organizationId: string; by: Actor }> {
  const who = await actor();
  if (!(await canSeeTask(who.organizationId, taskId, who.by.personId!))) throw new WorkError("That task doesn't exist.");
  return who;
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
    if (error instanceof WorkError || error instanceof OperationError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Try again." };
  }
}

/** Does one of the task actions (lib/actions/tasks.ts) as the signed-in person. */
async function perform(name: string, input: object): Promise<TaskActionResult> {
  const actor = actorOf(await requireAppContext());
  return attempt(async () => void (await performAs(actor, name, input)));
}

/** The same, returning how the task was before, for undo (restoreAction). */
async function performWithUndo(taskId: string, name: string, input: object): Promise<TaskActionResult> {
  const context = await requireAppContext();
  return attempt(async () => {
    const before = await getTask(context.organization.id, taskId, { viewer: context.person.id });
    if (!before) throw new WorkError("That task doesn't exist.");
    await performAs(actorOf(context), name, input);
    return { snapshot: snapshot(before) };
  });
}

export async function createTaskAction(input: {
  title: string;
  description?: string;
  priority?: Priority;
  personIds?: string[];
  agentIds?: string[];
  workerRole?: string | null;
  /** Everyone in the company sees it; otherwise only you and the people on it. */
  shared?: boolean;
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
      visibility: input.shared ? "company" : "private",
      by,
    });
    return { number: task.number };
  });
}

/** Replies on a task; files attached to the reply were uploaded to Blob first (/api/uploads). */
export async function replyAction(
  taskId: string,
  text: string,
  uploads: { name: string; blobPathname: string }[] = [],
): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  if (uploads.length > MAX_REPLY_ATTACHMENTS) return { error: `Attach at most ${MAX_REPLY_ATTACHMENTS} files at a time.` };
  return attempt(async () => {
    const attachments = [];
    for (const upload of uploads) {
      try {
        attachments.push({ name: upload.name, bytes: await readUpload(organizationId, upload.blobPathname) });
      } catch {
        throw new WorkError(`Couldn't read ${upload.name}. Remove it and attach it again.`);
      }
    }
    await replyToTask(organizationId, taskId, by, text, attachments);
    await discardUploads(organizationId, uploads.map((u) => u.blobPathname));
  });
}

export async function sendQueuedNowAction(taskId: string, messageId: string): Promise<TaskActionResult> {
  const { organizationId } = await actorFor(taskId);
  return attempt(async () => {
    await sendQueuedNow(organizationId, taskId, messageId);
  });
}

export async function pickOptionAction(taskId: string, index: number): Promise<TaskActionResult> {
  return perform("task.pick_option", { task: taskId, option: index + 1 });
}

/** E: takes the recommended option, or marks the task done. Returns what to restore on undo. */
export async function approveOrDoneAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
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
  return performWithUndo(taskId, "task.set_status", { task: taskId, status });
}

export async function setPriorityAction(taskId: string, priority: Priority): Promise<TaskActionResult> {
  return performWithUndo(taskId, "task.set_priority", { task: taskId, priority });
}

/** Puts a task off until a time (ISO string), or brings it back with null. */
export async function laterAction(taskId: string, until: string | null): Promise<TaskActionResult> {
  return performWithUndo(taskId, "task.later", { task: taskId, until });
}

/** Z: puts status, priority and "later" back to how they were. */
export async function restoreAction(taskId: string, previous: TaskSnapshot): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
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
  return perform("task.edit", { task: taskId, ...patch });
}

export async function addMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string; workerRole?: string },
): Promise<TaskActionResult> {
  return perform("task.add_member", { task: taskId, member: member.personId ?? member.agentId, workerRole: member.workerRole });
}

export async function removeMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string },
): Promise<TaskActionResult> {
  return perform("task.remove_member", { task: taskId, member: member.personId ?? member.agentId });
}

export async function runAgentAction(taskId: string, agentId: string): Promise<TaskActionResult> {
  return perform("task.run_agent", { task: taskId, agent: agentId });
}

export type TaskHit = { id: string; number: number; title: string; status: TaskStatus };

export async function searchTasksAction(query: string): Promise<TaskHit[]> {
  const { organization, person } = await requireAppContext();
  const tasks = await search(organization.id, query, 12, { viewer: person.id });
  return tasks.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status }));
}

export async function archiveAction(taskId: string): Promise<TaskActionResult> {
  return perform("task.archive", { task: taskId, archived: true });
}

export async function unarchiveAction(taskId: string): Promise<TaskActionResult> {
  return perform("task.archive", { task: taskId, archived: false });
}

/** Attaches a company file to a job as an input. */
export async function attachFileAction(taskId: string, fileId: string): Promise<TaskActionResult> {
  return perform("task.attach_file", { task: taskId, file: fileId });
}

export async function detachFileAction(taskId: string, fileId: string): Promise<TaskActionResult> {
  return perform("task.detach_file", { task: taskId, file: fileId });
}

/** Makes a job repeat, or changes its schedule. */
export async function setScheduleAction(
  taskId: string,
  input: { cron: string; timezone: string; mode: "script" | "agent" },
): Promise<TaskActionResult> {
  return perform("task.set_schedule", { task: taskId, ...input });
}

export async function pauseScheduleAction(taskId: string, paused: boolean): Promise<TaskActionResult> {
  return perform("task.pause_schedule", { task: taskId, paused });
}

export async function removeScheduleAction(taskId: string): Promise<TaskActionResult> {
  return perform("task.remove_schedule", { task: taskId });
}

/** Replays the job's run.sh now. */
export async function rerunAction(taskId: string): Promise<TaskActionResult> {
  return perform("task.rerun_script", { task: taskId });
}

/** Shares a task with the whole company, or makes it private to whoever created it and the people on it (they or an admin). */
export async function setVisibilityAction(taskId: string, visibility: TaskVisibility): Promise<TaskActionResult> {
  return perform("task.set_visibility", { task: taskId, visibility });
}
