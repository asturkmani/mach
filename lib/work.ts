import "server-only";

import { loginCodeFrom, sealLoginCode } from "@/lib/agents/browser-steps";
import { agentToWake, dispatchRun, dispatchScheduled, startIfReady } from "@/lib/agents/dispatch";
import { createWorker, findAgentByName, listAgents, updateAgent, type Agent } from "@/lib/agents/store";
import { attachToTask, listTaskFiles, MAX_FILE_BYTES, saveVersion } from "@/lib/files";
import { rememberTimezone } from "@/lib/orgs";
import { recordMentions } from "@/lib/task-mentions";
import { listPeople, type Person } from "@/lib/people";
import { PEOPLE_SECTION, SECTIONS, setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import { sandboxes } from "@/lib/sandbox";
import {
  deleteSchedule,
  rescheduleFromNow,
  saveSchedule,
  scheduleProblem,
  setPaused,
  takeDueRuns,
  type Schedule,
  type ScheduleMode,
} from "@/lib/schedules";
import { STATUS_WORDS } from "@/lib/task-words";
import {
  addMember,
  addMessage,
  agentsOn,
  CLOSED_STATUSES,
  createTask,
  getTask,
  isRunning,
  QUEUED,
  requestInterrupt,
  listMessages,
  reactToMessages,
  resetAgentTurns,
  saveLoginCode,
  setArchived,
  setSandboxName,
  updateTask,
  type Priority,
  type Task,
  type TaskStatus,
} from "@/lib/tasks";

// What people and the Chief of Staff do to tasks. Each operation records what
// happened on the task's thread and starts agent runs when there is work for
// an agent.

export type Actor = { name: string; personId?: string };


export class WorkError extends Error {}

/** Resolves names to people and agents in the organization, or explains which names are unknown. */
export async function resolveTeam(
  organizationId: string,
  names: { people?: string[]; agents?: string[] },
): Promise<{ people: Person[]; agents: Agent[] }> {
  const everyone = await listPeople(organizationId);
  const people: Person[] = [];
  for (const name of names.people ?? []) {
    const person = everyone.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    if (!person) throw new WorkError(`No one called ${name} is on the team. People: ${everyone.map((p) => p.name).join(", ")}.`);
    people.push(person);
  }
  const agents: Agent[] = [];
  for (const name of names.agents ?? []) {
    const agent = await findAgentByName(organizationId, name);
    if (!agent) throw new WorkError(`There is no agent called ${name}.`);
    agents.push(agent);
  }
  return { people, agents };
}

/** Keeps only ids of people and active agents in this organization, so a request can't reach into another company. */
async function ownIds(organizationId: string, ids: { personIds?: string[]; agentIds?: string[] }) {
  const people = new Set((await listPeople(organizationId)).map((p) => p.id));
  const agents = new Set((await listAgents(organizationId)).filter((a) => a.status === "active").map((a) => a.id));
  return {
    personIds: (ids.personIds ?? []).filter((id) => people.has(id)),
    agentIds: (ids.agentIds ?? []).filter((id) => agents.has(id)),
  };
}

export async function createTaskWithTeam(
  organizationId: string,
  input: {
    title: string;
    description?: string;
    priority?: Priority;
    status?: TaskStatus;
    personIds?: string[];
    agentIds?: string[];
    /** Adds a new worker agent with this role ("" for a general worker). */
    workerRole?: string;
    /** Library files the job starts from. */
    inputFileIds?: string[];
    /** Makes it a recurring job. Its first run starts now. */
    schedule?: ScheduleInput;
    by: Actor;
  },
): Promise<Task> {
  if (input.schedule) checkSchedule(input.schedule);
  const own = await ownIds(organizationId, input);
  const agentIds = [...own.agentIds];
  if (input.workerRole !== undefined) agentIds.push((await createWorker(organizationId, input.workerRole)).id);
  const task = await createTask(organizationId, {
    title: input.title,
    description: input.description,
    priority: input.priority,
    status: input.status ?? "ready",
    createdBy: { personId: input.by.personId },
    people: [...(input.by.personId ? [input.by.personId] : []), ...own.personIds],
    agents: agentIds,
  });
  for (const fileId of input.inputFileIds ?? []) await attachToTask(organizationId, task.id, fileId, "input");
  await addMessage(task.id, { author: input.by.name, personId: input.by.personId, kind: "event", body: "Created this task." });
  if (input.schedule) await scheduleTask(organizationId, task.id, input.by, input.schedule);
  await startIfReady(organizationId, task.id);
  return (await getTask(organizationId, task.id))!;
}

/** A person writes on the task. If agents are on it, the right one picks it up again. */
/** A file someone attached to a reply. */
export type ReplyAttachment = { name: string; bytes: Buffer };

export const MAX_REPLY_ATTACHMENTS = 10;

export async function replyToTask(
  organizationId: string,
  taskId: string,
  by: Actor,
  text: string,
  attachments: ReplyAttachment[] = [],
): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const body = text.trim();
  if (!body && attachments.length === 0) throw new WorkError("Write something first.");
  if (attachments.length > MAX_REPLY_ATTACHMENTS) throw new WorkError(`Attach at most ${MAX_REPLY_ATTACHMENTS} files at a time.`);
  for (const file of attachments) {
    if (file.bytes.length > MAX_FILE_BYTES) throw new WorkError(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  // A website sign-in waiting for a code: a reply that is one goes to the sign-in, sealed, not into the thread.
  const code = task.pendingLogin && attachments.length === 0 ? loginCodeFrom(body) : null;
  if (code) await saveLoginCode(task.id, sealLoginCode(code));
  // Attached files join the task as inputs (a file with the same name becomes its next version).
  const versions = [];
  for (const file of attachments) {
    const saved = await saveVersion(organizationId, {
      name: file.name,
      kind: "deliverable",
      bytes: file.bytes,
      taskId: task.id,
      personId: by.personId,
      role: "input",
      note: `Attached by ${by.name} in the thread`,
    });
    versions.push(saved.versionId);
  }
  const messageId = await addMessage(task.id, {
    author: by.name,
    personId: by.personId,
    kind: "comment",
    body: code ? `Sent the ${task.pendingLogin} sign-in code.` : body,
    attachments: versions,
  });
  await resetAgentTurns(task.id);
  // @-mentions add people and agents to the task; mentioned people see it in their Needs you.
  const mentioned = code ? { people: [], agents: [] } : await recordMentions(organizationId, task, body, by, { agents: true });
  const current = mentioned.people.length || mentioned.agents.length ? await mustGet(organizationId, task.id) : task;

  // Replying on a done job reopens it: the same agent picks it up in the same sandbox. A message only
  // for other people (it mentions people but no agent) leaves the agents be.
  const forPeopleOnly = mentioned.people.length > 0 && mentioned.agents.length === 0;
  const agentId = forPeopleOnly ? undefined : agentToWake(current, await listMessages(task.id), body);
  if (agentId && !task.archivedAt && task.kind === "task") {
    const working = isRunning(current);
    // While an agent works, the message is queued (⏳) for when it finishes what it's doing (sendQueuedNow
    // stops it sooner). Otherwise 👀: the agent has it.
    if (!working) await updateTask(organizationId, task.id, { status: "ready", laterUntil: null, options: [] });
    if (messageId) await reactToMessages(agentId, [messageId], working ? QUEUED : "👀");
    // If no run takes it after all (the one working just ended), this one does.
    await dispatchRun(organizationId, task.id, agentId);
  }
  return (await getTask(organizationId, task.id))!;
}

/**
 * Send now for a reply that is queued (⏳) for a working agent: the run stops at
 * its next step and starts again with it. False if nothing was waiting.
 */
export async function sendQueuedNow(organizationId: string, taskId: string, messageId: string): Promise<boolean> {
  const task = await mustGet(organizationId, taskId);
  const message = (await listMessages(task.id)).find((m) => m.id === messageId);
  const queued = message?.reactions.filter((r) => r.emoji === QUEUED) ?? [];
  if (!message || queued.length === 0) return false;
  for (const r of queued) await reactToMessages(r.agentId, [message.id], "👀");
  if (!(await requestInterrupt(task.id))) await startIfReady(organizationId, task.id);
  return true;
}

/** Picks one of the options on the task's current ask. */
export async function pickOption(organizationId: string, taskId: string, by: Actor, index: number): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const option = task.options[index];
  if (!option) throw new WorkError("That option isn't available any more.");

  if (task.kind === "join_request") throw new WorkError("An admin answers this from their inbox.");
  if (task.kind === "suggestion") {
    return /^apply/i.test(option.label)
      ? applySuggestion(organizationId, task, by)
      : setStatus(organizationId, task.id, "cancelled", by, "Dismissed this suggestion.");
  }
  if (agentsOn(task).length === 0) {
    await addMessage(task.id, { author: by.name, personId: by.personId, kind: "comment", body: option.label });
    await updateTask(organizationId, task.id, { options: [] });
    return (await getTask(organizationId, task.id))!;
  }
  return replyToTask(organizationId, task.id, by, option.label);
}

/** E: take the recommended option when there is one, otherwise mark the task done. */
export async function approveOrDone(organizationId: string, taskId: string, by: Actor): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const recommended = task.options.findIndex((o) => o.recommended);
  if (recommended >= 0 && task.status !== "done") return pickOption(organizationId, task.id, by, recommended);
  return setStatus(organizationId, task.id, "done", by);
}

export async function setStatus(
  organizationId: string,
  taskId: string,
  status: TaskStatus,
  by: Actor,
  note?: string,
): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  if (task.status !== status) {
    await updateTask(organizationId, task.id, {
      status,
      ...(CLOSED_STATUSES.includes(status) ? { options: [], laterUntil: null } : {}),
    });
    await addMessage(task.id, {
      author: by.name,
      personId: by.personId,
      kind: "event",
      body: note ?? `Moved this to ${STATUS_WORDS[status]}.`,
    });
    if (status === "ready") await startIfReady(organizationId, task.id);
  }
  return (await getTask(organizationId, task.id))!;
}

/**
 * Retires a job: it leaves every list, its sandbox is deleted and its worker
 * agents are archived. Its files stay in the company library. Done only ends a
 * round; a done job keeps its sandbox and agents so it can be picked up again.
 */
export async function archiveTask(organizationId: string, taskId: string, by: Actor): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  if (task.archivedAt) return task;
  if (task.runStartedAt && isRunning(task)) throw new WorkError("An agent is working on this. Archive it when it's done.");
  if (task.sandboxName) {
    await sandboxes().remove(task.sandboxName);
    await setSandboxName(task.id, null);
  }
  for (const agent of agentsOn(task)) {
    if (agent.kind === "worker") await updateAgent(organizationId, agent.id, { status: "archived" });
  }
  await setArchived(organizationId, task.id, true);
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: "Archived this job." });
  return (await getTask(organizationId, task.id))!;
}

/** Brings an archived job back. Its sandbox is rebuilt from its files the next time code runs. */
export async function unarchiveTask(organizationId: string, taskId: string, by: Actor): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  if (!task.archivedAt) return task;
  for (const agent of agentsOn(task)) {
    if (agent.kind === "worker") await updateAgent(organizationId, agent.id, { status: "active" });
  }
  await setArchived(organizationId, task.id, false);
  // A recurring job picks up at its next run from now, not the runs it missed.
  await rescheduleFromNow(task.id);
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: "Brought this job back." });
  return (await getTask(organizationId, task.id))!;
}

export async function addToTask(
  organizationId: string,
  taskId: string,
  by: Actor,
  member: { personId?: string; agentId?: string; workerRole?: string },
): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const own = await ownIds(organizationId, {
    personIds: member.personId ? [member.personId] : [],
    agentIds: member.agentId ? [member.agentId] : [],
  });
  if ((member.personId && !own.personIds.length) || (member.agentId && !own.agentIds.length)) {
    throw new WorkError("That person or agent isn't in this company.");
  }
  let agentId = member.agentId;
  if (member.workerRole !== undefined) agentId = (await createWorker(organizationId, member.workerRole)).id;
  if (!member.personId && !agentId) throw new WorkError("Pick someone to add.");
  await addMember(task.id, member.personId ? { personId: member.personId } : { agentId });
  const updated = (await getTask(organizationId, task.id))!;
  const added = updated.members.find((m) => m.id === (member.personId ?? agentId));
  if (added) {
    await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: `Added ${added.name}.` });
  }
  if (agentId) await startIfReady(organizationId, task.id);
  return (await getTask(organizationId, task.id))!;
}

/** Starts a specific agent on the task now (the Run button). */
export async function runNow(organizationId: string, taskId: string, agentId: string, by: Actor): Promise<void> {
  const task = await mustGet(organizationId, taskId);
  if (!agentsOn(task).some((a) => a.id === agentId)) throw new WorkError("That agent isn't on this task.");
  if (task.archivedAt) throw new WorkError("Bring the job back from the archive first.");
  await resetAgentTurns(task.id);
  await updateTask(organizationId, task.id, { status: "ready" });
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: "Started a run." });
  await dispatchRun(organizationId, task.id, agentId);
}

// ---------------------------------------------------------------------------
// Recurring jobs

export type ScheduleInput = { cron: string; timezone: string; mode?: ScheduleMode; quiet?: boolean };

function checkSchedule(input: ScheduleInput): void {
  const problem = scheduleProblem(input.cron, input.timezone);
  if (problem) throw new WorkError(problem);
}

/** Makes a job repeat (or changes how). Each run lands on the same card and works in the same sandbox. */
export async function scheduleTask(organizationId: string, taskId: string, by: Actor, input: ScheduleInput): Promise<Schedule> {
  const task = await mustGet(organizationId, taskId);
  if (task.kind !== "task") throw new WorkError("Only jobs can repeat.");
  checkSchedule(input);
  const schedule = await saveSchedule(task.id, { ...input, by: { personId: by.personId } });
  // The first schedule someone sets tells us the company's timezone.
  await rememberTimezone(organizationId, input.timezone);
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: `Set this job to repeat: ${schedule.description}.` });
  return schedule;
}

export async function pauseTaskSchedule(organizationId: string, taskId: string, by: Actor, paused: boolean): Promise<void> {
  const task = await mustGet(organizationId, taskId);
  const schedule = await setPaused(task.id, paused);
  if (!schedule) throw new WorkError("This job doesn't repeat.");
  await addMessage(task.id, {
    author: by.name,
    personId: by.personId,
    kind: "event",
    body: paused ? "Paused this job's schedule." : "Resumed this job's schedule.",
  });
}

export async function unscheduleTask(organizationId: string, taskId: string, by: Actor): Promise<void> {
  const task = await mustGet(organizationId, taskId);
  if (await deleteSchedule(task.id)) {
    await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: "Stopped this job repeating." });
  }
}

/** "Run again": replays the job's run.sh now, without a model; the agent is woken only if it fails. */
export async function rerunScript(organizationId: string, taskId: string, by: Actor): Promise<void> {
  const task = await mustGet(organizationId, taskId);
  if (task.archivedAt) throw new WorkError("Bring the job back from the archive first.");
  if (isRunning(task)) throw new WorkError("A run is going. Try again when it's done.");
  const files = await listTaskFiles(organizationId, task.id);
  if (!files.some((f) => f.kind === "code" && f.name === "run.sh")) throw new WorkError("This job has no run.sh to run again.");
  if (!agentsOn(task).some((a) => a.status === "active")) throw new WorkError("Put an agent on the job first.");
  await dispatchScheduled(organizationId, task.id, { kind: "rerun", by: by.name, personId: by.personId });
}

/** The cron tick: starts every recurring job that is due. Returns how many started. */
export async function fireDueSchedules(now = new Date()): Promise<number> {
  const due = await takeDueRuns(now);
  for (const run of due) {
    try {
      await dispatchScheduled(run.organizationId, run.taskId, { kind: "schedule", dueAt: run.dueAt.toISOString() });
    } catch (error) {
      console.error(`Couldn't start the scheduled run of task ${run.taskId}`, error);
    }
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Profile suggestions: the Chief of Staff proposes, a person applies.

export type ProfileSuggestion = { section: string; content: string; reason: string };

export async function suggestProfileUpdate(
  organizationId: string,
  by: { personId: string },
  suggestion: ProfileSuggestion,
): Promise<Task> {
  const section = SECTIONS.find((s) => s.toLowerCase() === suggestion.section.trim().toLowerCase());
  if (!section || section === PEOPLE_SECTION) throw new WorkError(`Can't suggest changes to ${suggestion.section}.`);
  const task = await createTask(organizationId, {
    kind: "suggestion",
    title: `Update ${section}`,
    description: suggestion.content,
    summary: suggestion.reason,
    status: "review",
    payload: { section, content: suggestion.content },
    options: [
      { label: "Apply", recommended: true },
      { label: "Dismiss", recommended: false },
    ],
    people: [by.personId],
  });
  await addMessage(task.id, { author: "Chief of Staff", kind: "result", body: suggestion.reason });
  return task;
}

export async function applySuggestion(organizationId: string, task: Task, by: Actor): Promise<Task> {
  if (task.kind !== "suggestion" || !task.payload) throw new WorkError("This isn't a profile suggestion.");
  if (task.status === "done") return task;
  const { section, content } = task.payload as { section: string; content: string };
  await updateProfile(organizationId, (markdown) => setSection(markdown, section, content));
  return setStatus(organizationId, task.id, "done", by, `Applied this change to ${section}.`);
}

async function mustGet(organizationId: string, taskId: string): Promise<Task> {
  const task = await getTask(organizationId, taskId);
  if (!task) throw new WorkError("That task no longer exists.");
  return task;
}
