"use server";

import { refresh } from "next/cache";

import { searchTasks as search, updateTask, type Priority, type Task, type TaskStatus } from "@/lib/tasks";
import { PRIORITIES, TASK_STATUSES } from "@/lib/task-words";
import { requireAppContext } from "@/lib/session";
import { attachToTask, detachFromTask, discardUploads, readUpload } from "@/lib/files";
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
  sendQueuedNow,
  setStatus,
  unscheduleTask,
  MAX_REPLY_ATTACHMENTS,
  WorkError,
  type Actor,
} from "@/lib/work";
import { addMessage, canSeeTask, getTask, removeMember, setTaskVisibility, type TaskVisibility } from "@/lib/tasks";
import { decideJoinRequest } from "@/lib/members";

// Everything the task screens do. Each returns an error message for the person
// rather than throwing, and refreshes the page data on success.

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

/** A colleague asking to join: only an admin answers, by letting them in (the first option) or declining. */
async function answerJoinRequest(taskId: string, index: number): Promise<TaskActionResult | null> {
  const { organization, person, isAdmin } = await requireAppContext();
  const task = await getTask(organization.id, taskId);
  if (task?.kind !== "join_request") return null;
  if (!isAdmin) return { error: "Only an admin can let someone in." };
  return attempt(async () => {
    await decideJoinRequest(organization.id, taskId, index === 0, { name: person.name, personId: person.id });
  });
}

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
  const joining = await answerJoinRequest(taskId, index);
  if (joining) return joining;
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await pickOption(organizationId, taskId, by, index);
  });
}

/** E: takes the recommended option, or marks the task done. Returns what to restore on undo. */
export async function approveOrDoneAction(taskId: string): Promise<TaskActionResult> {
  const joining = await answerJoinRequest(taskId, 0);
  if (joining) return joining;
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
  const { organizationId, by } = await actorFor(taskId);
  if (!TASK_STATUSES.includes(status)) return { error: "Unknown status." };
  return attempt(async () => {
    const before = await getTask(organizationId, taskId);
    if (!before) throw new WorkError("That task no longer exists.");
    await setStatus(organizationId, taskId, status, by);
    return { snapshot: snapshot(before) };
  });
}

export async function setPriorityAction(taskId: string, priority: Priority): Promise<TaskActionResult> {
  const { organizationId } = await actorFor(taskId);
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
  const { organizationId, by } = await actorFor(taskId);
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
  const { organizationId } = await actorFor(taskId);
  return attempt(async () => {
    if (patch.title !== undefined && !patch.title.trim()) throw new WorkError("A task needs a title.");
    await updateTask(organizationId, taskId, patch);
  });
}

export async function addMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string; workerRole?: string },
): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await addToTask(organizationId, taskId, by, member);
  });
}

export async function removeMemberAction(
  taskId: string,
  member: { personId?: string; agentId?: string },
): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
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
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await runNow(organizationId, taskId, agentId, by);
  });
}

export type TaskHit = { id: string; number: number; title: string; status: TaskStatus };

export async function searchTasksAction(query: string): Promise<TaskHit[]> {
  const { organization, person } = await requireAppContext();
  const tasks = await search(organization.id, query, 12, { viewer: person.id });
  return tasks.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status }));
}

export async function archiveAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await archiveTask(organizationId, taskId, by);
  });
}

export async function unarchiveAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await unarchiveTask(organizationId, taskId, by);
  });
}

/** Attaches a company file to a job as an input. */
export async function attachFileAction(taskId: string, fileId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
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
  const { organizationId } = await actorFor(taskId);
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
  const { organizationId, by } = await actorFor(taskId);
  if (input.mode !== "script" && input.mode !== "agent") return { error: "Pick how each run works." };
  return attempt(async () => {
    await scheduleTask(organizationId, taskId, by, input);
  });
}

export async function pauseScheduleAction(taskId: string, paused: boolean): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await pauseTaskSchedule(organizationId, taskId, by, paused);
  });
}

export async function removeScheduleAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await unscheduleTask(organizationId, taskId, by);
  });
}

/** Replays the job's run.sh now. */
export async function rerunAction(taskId: string): Promise<TaskActionResult> {
  const { organizationId, by } = await actorFor(taskId);
  return attempt(async () => {
    await rerunScript(organizationId, taskId, by);
  });
}

/** Shares a task with the whole company, or makes it private to whoever created it and the people on it (they or an admin). */
export async function setVisibilityAction(taskId: string, visibility: TaskVisibility): Promise<TaskActionResult> {
  const { organization, person, isAdmin } = await requireAppContext();
  const task = await getTask(organization.id, taskId, { viewer: person.id });
  if (!task) return { error: "That task doesn't exist." };
  if (task.createdByPersonId !== person.id && !isAdmin) return { error: "Only whoever created it, or an admin, can change who sees it." };
  return attempt(async () => {
    await setTaskVisibility(organization.id, taskId, visibility === "company" ? "company" : "private");
  });
}
