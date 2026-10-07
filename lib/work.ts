import "server-only";

import { agentToWake, dispatchRun, startIfReady } from "@/lib/agents/dispatch";
import { createWorker, findAgentByName, listAgents, updateAgent, type Agent } from "@/lib/agents/store";
import { listPeople, type Person } from "@/lib/people";
import { PEOPLE_SECTION, SECTIONS, setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import { STATUS_WORDS } from "@/lib/task-words";
import {
  addMember,
  addMessage,
  agentsOn,
  CLOSED_STATUSES,
  createTask,
  getTask,
  listMessages,
  resetAgentTurns,
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
    by: Actor;
  },
): Promise<Task> {
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
  await addMessage(task.id, { author: input.by.name, personId: input.by.personId, kind: "event", body: "Created this task." });
  await startIfReady(organizationId, task.id);
  return (await getTask(organizationId, task.id))!;
}

/** A person writes on the task. If agents are on it, the right one picks it up again. */
export async function replyToTask(organizationId: string, taskId: string, by: Actor, text: string): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const body = text.trim();
  if (!body) throw new WorkError("Write something first.");
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "comment", body });
  await resetAgentTurns(task.id);

  const agentId = agentToWake(task, await listMessages(task.id), body);
  if (agentId && !CLOSED_STATUSES.includes(task.status) && task.kind === "task") {
    await updateTask(organizationId, task.id, { status: "ready", laterUntil: null, options: [] });
    dispatchRun(organizationId, task.id, agentId);
  }
  return (await getTask(organizationId, task.id))!;
}

/** Picks one of the options on the task's current ask. */
export async function pickOption(organizationId: string, taskId: string, by: Actor, index: number): Promise<Task> {
  const task = await mustGet(organizationId, taskId);
  const option = task.options[index];
  if (!option) throw new WorkError("That option isn't available any more.");

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
    if (CLOSED_STATUSES.includes(status)) await archiveWorkers(organizationId, task);
    if (status === "ready") await startIfReady(organizationId, task.id);
  }
  return (await getTask(organizationId, task.id))!;
}

/** Worker agents exist for one task; when it closes they're archived. */
async function archiveWorkers(organizationId: string, task: Task): Promise<void> {
  for (const agent of agentsOn(task)) {
    if (agent.kind === "worker") await updateAgent(organizationId, agent.id, { status: "archived" });
  }
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
  if (CLOSED_STATUSES.includes(task.status)) throw new WorkError("Reopen the task first.");
  await resetAgentTurns(task.id);
  await updateTask(organizationId, task.id, { status: "ready" });
  await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: "Started a run." });
  dispatchRun(organizationId, task.id, agentId);
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
