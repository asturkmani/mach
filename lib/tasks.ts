import "server-only";

import { getDb } from "@/lib/db";
import { pushConfigured, pushToPeople } from "@/lib/push";
import type { AgentKind, AgentStatus } from "@/lib/agents/store";

// Tasks are the jobs people and agents do together. Any mix of people and
// agents can be on a task. A task "needs you" when you're on it and it is
// waiting on a person: an agent asked something, finished work to review, or
// no agent is on it at all.

import { PRIORITIES, TASK_STATUSES, type Priority, type TaskStatus } from "@/lib/task-words";

export { PRIORITIES, TASK_STATUSES, type Priority, type TaskStatus };

export const CLOSED_STATUSES: TaskStatus[] = ["done", "cancelled"];

export type TaskKind = "task" | "suggestion" | "join_request";
export type TaskOption = { label: string; recommended?: boolean };

export type TaskMember =
  | { type: "person"; id: string; name: string; role: string }
  | { type: "agent"; id: string; name: string; role: string; kind: AgentKind; status: AgentStatus };

export type Task = {
  id: string;
  number: number;
  kind: TaskKind;
  title: string;
  description: string;
  summary: string;
  context: string;
  progress: string;
  status: TaskStatus;
  priority: Priority;
  options: TaskOption[];
  payload: Record<string, unknown> | null;
  laterUntil: Date | null;
  createdByPersonId: string | null;
  createdByAgentId: string | null;
  runAgentId: string | null;
  runStartedAt: Date | null;
  /** When the current run began, and what its agent is doing now. */
  runBeganAt: Date | null;
  runActivity: string;
  agentTurns: number;
  /** The job's notes (the agent's NOTES.md): how to rerun it, variants tried, results. */
  memory: string;
  sandboxName: string | null;
  archivedAt: Date | null;
  /** It has an active (unpaused) schedule. */
  repeats: boolean;
  /** A website sign-in waiting on a person's code (the login's slug). */
  pendingLogin: string | null;
  /** Who @-mentioned the person this list is for, when that's why it needs them. */
  mentionedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  members: TaskMember[];
};

export type TaskMessageKind = "comment" | "update" | "ask" | "result" | "event";

/** An agent's reaction to a message: 👀 on it, ✅ done, 💬 asked, 🤝 handed off, ⚠️ hit a problem. */
export type MessageReaction = { agentId: string; agentName: string; emoji: string };

/** A file attached to a message in the thread. */
export type MessageAttachment = { versionId: string; fileId: string; name: string; contentType: string; size: number; version: number };

export type TaskMessage = {
  id: string;
  author: string;
  personId: string | null;
  agentId: string | null;
  kind: TaskMessageKind;
  body: string;
  createdAt: Date;
  /** How long the run took, on an agent's result. */
  durationMs: number | null;
  attachments: MessageAttachment[];
  reactions: MessageReaction[];
};

type TaskRow = {
  id: string;
  number: number;
  kind: TaskKind;
  title: string;
  description: string;
  summary: string;
  context: string;
  progress: string;
  status: TaskStatus;
  priority: Priority;
  options: TaskOption[] | null;
  payload: Record<string, unknown> | null;
  later_until: Date | null;
  created_by_person_id: string | null;
  created_by_agent_id: string | null;
  run_agent_id: string | null;
  run_started_at: Date | null;
  run_began_at: Date | null;
  run_activity: string;
  agent_turns: number;
  memory: string;
  sandbox_name: string | null;
  archived_at: Date | null;
  repeats: boolean;
  pending_login: string | null;
  mentioned_by?: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
};

type MemberRow = {
  task_id: string;
  person_id: string | null;
  agent_id: string | null;
  person_name: string | null;
  person_role: string | null;
  agent_name: string | null;
  agent_role: string | null;
  agent_kind: AgentKind | null;
  agent_status: AgentStatus | null;
};

const TASK_COLUMNS = `t.id, t.number, t.kind, t.title, t.description, t.summary, t.context, t.progress, t.status,
  t.priority, t.options, t.payload, t.later_until, t.created_by_person_id, t.created_by_agent_id, t.run_agent_id,
  t.run_started_at, t.run_began_at, t.run_activity, t.agent_turns, t.memory, t.sandbox_name, t.archived_at,
  exists (select 1 from task_schedules s where s.task_id = t.id and not s.paused) as repeats, t.pending_login,
  t.created_at, t.updated_at, t.closed_at`;

/** Sorts urgent first, then high, medium, low. */
export const PRIORITY_ORDER = `case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

/** How long an agent run may hold a task before it's considered dead. */
const LEASE = "15 minutes";

function toTask(row: TaskRow, members: TaskMember[]): Task {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    title: row.title,
    description: row.description,
    summary: row.summary,
    context: row.context,
    progress: row.progress,
    status: row.status,
    priority: row.priority,
    options: row.options ?? [],
    payload: row.payload,
    laterUntil: row.later_until,
    createdByPersonId: row.created_by_person_id,
    createdByAgentId: row.created_by_agent_id,
    runAgentId: row.run_agent_id,
    runStartedAt: row.run_started_at,
    runBeganAt: row.run_began_at,
    runActivity: row.run_activity,
    agentTurns: row.agent_turns,
    memory: row.memory,
    sandboxName: row.sandbox_name,
    archivedAt: row.archived_at,
    repeats: row.repeats,
    pendingLogin: row.pending_login,
    mentionedBy: row.mentioned_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    members,
  };
}

async function withMembers(rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return [];
  const memberRows = await getDb().query<MemberRow>(
    `select m.task_id, m.person_id, m.agent_id, p.name as person_name, p.role as person_role,
            a.name as agent_name, a.role as agent_role, a.kind as agent_kind, a.status as agent_status
     from task_members m
     left join people p on p.id = m.person_id
     left join agents a on a.id = m.agent_id
     where m.task_id = any($1::uuid[])
     order by (m.person_id is null), m.added_at, coalesce(p.name, a.name)`,
    [rows.map((r) => r.id)],
  );
  const byTask = new Map<string, TaskMember[]>();
  for (const m of memberRows) {
    const member: TaskMember = m.person_id
      ? { type: "person", id: m.person_id, name: m.person_name ?? "", role: m.person_role ?? "" }
      : {
          type: "agent",
          id: m.agent_id!,
          name: m.agent_name ?? "",
          role: m.agent_role ?? "",
          kind: m.agent_kind ?? "worker",
          status: m.agent_status ?? "active",
        };
    byTask.set(m.task_id, [...(byTask.get(m.task_id) ?? []), member]);
  }
  return rows.map((row) => toTask(row, byTask.get(row.id) ?? []));
}

export const agentsOn = (task: Task) =>
  task.members.filter((m): m is Extract<TaskMember, { type: "agent" }> => m.type === "agent");
export const peopleOn = (task: Task) =>
  task.members.filter((m): m is Extract<TaskMember, { type: "person" }> => m.type === "person");

/**
 * Which agent should pick the task up after a person speaks: one they
 * mentioned by name, else the agent that last asked or reported, else the
 * first active agent on the task.
 */
export function agentToWake(task: Task, messages: TaskMessage[], text = ""): string | undefined {
  const active = agentsOn(task).filter((a) => a.status === "active");
  const mentioned = active.find((a) => text.toLowerCase().includes(`@${a.name.toLowerCase()}`));
  if (mentioned) return mentioned.id;
  const last = [...messages].reverse().find((m) => m.agentId && (m.kind === "ask" || m.kind === "result"));
  if (last && active.some((a) => a.id === last.agentId)) return last.agentId!;
  return active[0]?.id;
}

/** True while an agent run holds the task. */
export function isRunning(task: Pick<Task, "runStartedAt">, now = Date.now()): boolean {
  return Boolean(task.runStartedAt && now - new Date(task.runStartedAt).getTime() < 15 * 60_000);
}

// ---------------------------------------------------------------------------
// Reading

export async function getTask(organizationId: string, id: string): Promise<Task | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.id = $2`,
    [organizationId, id],
  );
  return (await withMembers(rows))[0] ?? null;
}

export async function getTaskByNumber(organizationId: string, number: number): Promise<Task | null> {
  if (!Number.isSafeInteger(number)) return null;
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.number = $2`,
    [organizationId, number],
  );
  return (await withMembers(rows))[0] ?? null;
}

/** Every task in the organization, open ones first. Closed tasks are limited to the most recent. */
export async function listTasks(organizationId: string, { closedLimit = 30 } = {}): Promise<Task[]> {
  const rows = await getDb().query<TaskRow>(
    `(select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.archived_at is null
        and t.status not in ('done', 'cancelled')
      order by ${PRIORITY_ORDER}, t.updated_at desc)
     union all
     (select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.archived_at is null
        and t.status in ('done', 'cancelled')
      order by t.closed_at desc nulls last limit $2)`,
    [organizationId, closedLimit],
  );
  return withMembers(rows);
}

const NEEDS_PERSON = `
  t.archived_at is null
  and t.status not in ('done', 'cancelled', 'backlog')
  and (t.later_until is null or t.later_until <= now())
  and (t.status in ('waiting', 'review')
       or (t.status = 'ready' and not exists (select 1 from task_members a where a.task_id = t.id and a.agent_id is not null)))`;

const IS_MEMBER = `exists (select 1 from task_members m where m.task_id = t.id and m.person_id = $2)`;

/** Someone @-mentioned this person on the task and they haven't opened it since. */
const MENTIONED = `(t.archived_at is null and exists (
  select 1 from task_mentions mm where mm.task_id = t.id and mm.person_id = $2 and mm.seen_at is null))`;

const NEEDS_THEM = `((${IS_MEMBER} and ${NEEDS_PERSON}) or ${MENTIONED})`;

/** What needs this person now, urgent first, newest first within a priority. */
export async function listInbox(organizationId: string, personId: string): Promise<Task[]> {
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS},
       (select mm.by_name from task_mentions mm where mm.task_id = t.id and mm.person_id = $2 and mm.seen_at is null) as mentioned_by
     from tasks t where t.organization_id = $1 and ${NEEDS_THEM}
     order by ${PRIORITY_ORDER}, t.updated_at desc`,
    [organizationId, personId],
  );
  return withMembers(rows);
}

export async function countInbox(organizationId: string, personId: string): Promise<number> {
  const [row] = await getDb().query<{ count: number }>(
    `select count(*)::int as count from tasks t where t.organization_id = $1 and ${NEEDS_THEM}`,
    [organizationId, personId],
  );
  return row.count;
}

/** Someone @-mentioned a person: the task needs them until they open it. */
export async function addMention(taskId: string, personId: string, byName: string): Promise<void> {
  await getDb().query(
    `insert into task_mentions (task_id, person_id, by_name) values ($1, $2, $3)
     on conflict (task_id, person_id) do update set by_name = excluded.by_name, created_at = now(), seen_at = null`,
    [taskId, personId, byName],
  );
  if (!pushConfigured()) return;
  const [task] = await getDb().query<{ organization_id: string; number: number; title: string }>(
    "select organization_id, number, title from tasks where id = $1",
    [taskId],
  );
  if (!task) return;
  await pushToPeople(
    task.organization_id,
    [personId],
    { title: `${byName} mentioned you on #${task.number}`, body: task.title, url: `/tasks/${task.number}`, tag: `mention-${taskId}` },
    { badge: () => countInbox(task.organization_id, personId) },
  );
}

export async function markMentionsSeen(taskId: string, personId: string): Promise<void> {
  await getDb().query("update task_mentions set seen_at = now() where task_id = $1 and person_id = $2 and seen_at is null", [
    taskId,
    personId,
  ]);
}

/** This person's open tasks that don't need them right now: agents working, queued, put off or not started. */
export async function listInProgress(organizationId: string, personId: string): Promise<Task[]> {
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and ${IS_MEMBER} and t.archived_at is null
       and t.status not in ('done', 'cancelled') and not (${NEEDS_PERSON}) and not ${MENTIONED}
     order by ${PRIORITY_ORDER}, t.updated_at desc`,
    [organizationId, personId],
  );
  return withMembers(rows);
}

export async function searchTasks(organizationId: string, query: string, limit = 20): Promise<Task[]> {
  const q = query.trim();
  const number = Number(q.replace(/^#/, ""));
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1
       and ($2 = '' or t.title ilike '%' || $2 || '%' or t.summary ilike '%' || $2 || '%' or t.number = $3)
     order by (t.status in ('done', 'cancelled')), t.updated_at desc limit $4`,
    [organizationId, q, Number.isSafeInteger(number) ? number : -1, limit],
  );
  return withMembers(rows);
}

/** Tasks that repeat on a schedule (archived ones aside), by number. */
export async function listScheduledTasks(organizationId: string): Promise<Task[]> {
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.archived_at is null
       and exists (select 1 from task_schedules s where s.task_id = t.id)
     order by t.number`,
    [organizationId],
  );
  return withMembers(rows);
}

export type TaskFilters = {
  /** Words in the title, description, summary or thread, or a task number. */
  query?: string;
  status?: TaskStatus;
  /** A person or agent on it, by name. */
  member?: string;
  includeClosed?: boolean;
  limit?: number;
};

/** Every matching task, open ones first, newest activity first. */
export async function findTasks(organizationId: string, filters: TaskFilters): Promise<Task[]> {
  const q = filters.query?.trim() ?? "";
  const number = Number(q.replace(/^#/, ""));
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1 and t.archived_at is null
       and ($2 = '' or t.number = $3 or t.title ilike '%' || $2 || '%' or t.summary ilike '%' || $2 || '%'
            or t.description ilike '%' || $2 || '%'
            or exists (select 1 from task_messages m where m.task_id = t.id and m.body ilike '%' || $2 || '%'))
       and ($4::text is null or t.status = $4)
       and ($5 or $4::text is not null or t.status not in ('done', 'cancelled'))
       and ($6::text is null or exists (
             select 1 from task_members tm left join people p on p.id = tm.person_id left join agents a on a.id = tm.agent_id
             where tm.task_id = t.id and lower(coalesce(p.name, a.name)) = lower($6)))
     order by (t.status in ('done', 'cancelled')), t.updated_at desc limit $7`,
    [
      organizationId,
      q,
      Number.isSafeInteger(number) ? number : -1,
      filters.status ?? null,
      filters.includeClosed ?? false,
      filters.member?.trim() || null,
      Math.min(Math.max(filters.limit ?? 20, 1), 50),
    ],
  );
  return withMembers(rows);
}

export async function listAgentTasks(organizationId: string, agentId: string): Promise<Task[]> {
  const rows = await getDb().query<TaskRow>(
    `select ${TASK_COLUMNS} from tasks t where t.organization_id = $1
       and exists (select 1 from task_members m where m.task_id = t.id and m.agent_id = $2)
     order by (t.status in ('done', 'cancelled')), t.updated_at desc limit 50`,
    [organizationId, agentId],
  );
  return withMembers(rows);
}

export async function listMessages(taskId: string): Promise<TaskMessage[]> {
  const rows = await getDb().query<{
    id: string;
    author: string;
    person_id: string | null;
    agent_id: string | null;
    kind: TaskMessageKind;
    body: string;
    created_at: Date;
    duration_ms: number | null;
  }>(
    "select id, author, person_id, agent_id, kind, body, created_at, duration_ms from task_messages where task_id = $1 order by created_at, id",
    [taskId],
  );
  const attached = await getDb().query<{
    message_id: string;
    version_id: string;
    file_id: string;
    name: string;
    content_type: string;
    size: number;
    version: number;
  }>(
    `select mf.message_id, v.id as version_id, f.id as file_id, f.name, v.content_type, v.size, v.version
     from task_message_files mf join task_messages m on m.id = mf.message_id
     join file_versions v on v.id = mf.version_id join files f on f.id = v.file_id
     where m.task_id = $1 order by f.name`,
    [taskId],
  );
  const byMessage = new Map<string, MessageAttachment[]>();
  for (const a of attached) {
    byMessage.set(a.message_id, [
      ...(byMessage.get(a.message_id) ?? []),
      { versionId: a.version_id, fileId: a.file_id, name: a.name, contentType: a.content_type, size: a.size, version: a.version },
    ]);
  }
  const reacted = await getDb().query<{ message_id: string; agent_id: string; agent_name: string; emoji: string }>(
    `select r.message_id, r.agent_id, a.name as agent_name, r.emoji
     from task_message_reactions r join task_messages m on m.id = r.message_id join agents a on a.id = r.agent_id
     where m.task_id = $1 order by r.updated_at`,
    [taskId],
  );
  const reactions = new Map<string, MessageReaction[]>();
  for (const r of reacted) {
    reactions.set(r.message_id, [...(reactions.get(r.message_id) ?? []), { agentId: r.agent_id, agentName: r.agent_name, emoji: r.emoji }]);
  }
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    personId: r.person_id,
    agentId: r.agent_id,
    kind: r.kind,
    body: r.body,
    createdAt: r.created_at,
    durationMs: r.duration_ms,
    attachments: byMessage.get(r.id) ?? [],
    reactions: reactions.get(r.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Writing

export type NewTask = {
  title: string;
  description?: string;
  summary?: string;
  status?: TaskStatus;
  priority?: Priority;
  kind?: TaskKind;
  options?: TaskOption[];
  payload?: Record<string, unknown>;
  createdBy?: { personId?: string; agentId?: string };
  people?: string[];
  agents?: string[];
};

export async function createTask(organizationId: string, input: NewTask): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error("A task needs a title.");
  const db = getDb();
  let id: string | undefined;
  // Numbers are per organization; retry if two tasks are created at the same moment.
  for (let attempt = 0; !id; attempt++) {
    try {
      const [row] = await db.query<{ id: string }>(
        `insert into tasks (organization_id, number, kind, title, description, summary, status, priority, options,
                            payload, created_by_person_id, created_by_agent_id)
         values ($1, (select coalesce(max(number), 0) + 1 from tasks where organization_id = $1), $2, $3, $4, $5, $6,
                 $7, $8::jsonb, $9::jsonb, $10, $11)
         returning id`,
        [
          organizationId,
          input.kind ?? "task",
          title,
          input.description?.trim() ?? "",
          input.summary?.trim() ?? "",
          input.status ?? "ready",
          input.priority ?? "medium",
          JSON.stringify(input.options ?? []),
          input.payload ? JSON.stringify(input.payload) : null,
          input.createdBy?.personId ?? null,
          input.createdBy?.agentId ?? null,
        ],
      );
      id = row.id;
    } catch (error) {
      if (attempt >= 3 || !String((error as Error).message).includes("tasks_org_number")) throw error;
    }
  }
  for (const personId of new Set(input.people ?? [])) await addMember(id, { personId });
  for (const agentId of new Set(input.agents ?? [])) await addMember(id, { agentId });
  return (await getTask(organizationId, id))!;
}

export type TaskPatch = Partial<{
  title: string;
  description: string;
  summary: string;
  context: string;
  progress: string;
  status: TaskStatus;
  priority: Priority;
  options: TaskOption[];
  laterUntil: Date | null;
}>;

export async function updateTask(organizationId: string, id: string, patch: TaskPatch): Promise<Task | null> {
  const set: string[] = [];
  const params: unknown[] = [organizationId, id];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    set.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error("A task needs a title.");
    add("title", patch.title.trim());
  }
  if (patch.description !== undefined) add("description", patch.description.trim());
  if (patch.summary !== undefined) add("summary", patch.summary.trim());
  if (patch.context !== undefined) add("context", patch.context.trim());
  if (patch.progress !== undefined) add("progress", patch.progress.trim());
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (patch.options !== undefined) add("options", JSON.stringify(patch.options), "::jsonb");
  if (patch.laterUntil !== undefined) add("later_until", patch.laterUntil);
  if (patch.status !== undefined) {
    add("status", patch.status);
    set.push(
      CLOSED_STATUSES.includes(patch.status) ? "closed_at = coalesce(closed_at, now())" : "closed_at = null",
    );
  }
  if (set.length === 0) return getTask(organizationId, id);
  // What the status was, to tell whether it just started needing someone.
  const [before] = await getDb().query<{ status: TaskStatus }>(
    `update tasks t set ${set.join(", ")}, updated_at = now()
     from (select status from tasks where organization_id = $1 and id = $2) as prior
     where t.organization_id = $1 and t.id = $2 returning prior.status`,
    params,
  );
  const task = await getTask(organizationId, id);
  if (task && before && patch.status && patch.status !== before.status && NOTIFY_STATUS[patch.status]) await notifyNeeded(organizationId, task);
  return task;
}

const NOTIFY_STATUS: Partial<Record<TaskStatus, string>> = { waiting: "needs your answer", review: "is ready for review" };

/** A task just started waiting on its people: a push notification to each of them (who turned them on). */
async function notifyNeeded(organizationId: string, task: Task): Promise<void> {
  if (!pushConfigured() || (task.laterUntil && task.laterUntil > new Date())) return;
  const people = task.members.filter((m) => m.type === "person").map((m) => m.id);
  await pushToPeople(
    organizationId,
    people,
    { title: `#${task.number} ${NOTIFY_STATUS[task.status]}`, body: task.summary || task.title, url: `/tasks/${task.number}`, tag: `task-${task.id}` },
    { badge: (personId) => countInbox(organizationId, personId) },
  );
}

export async function addMember(taskId: string, member: { personId?: string; agentId?: string }): Promise<void> {
  if (Boolean(member.personId) === Boolean(member.agentId)) throw new Error("Add either a person or an agent.");
  const db = getDb();
  if (member.personId) {
    await db.query(
      `insert into task_members (task_id, person_id) values ($1, $2)
       on conflict (task_id, person_id) where person_id is not null do nothing`,
      [taskId, member.personId],
    );
  } else {
    await db.query(
      `insert into task_members (task_id, agent_id) values ($1, $2)
       on conflict (task_id, agent_id) where agent_id is not null do nothing`,
      [taskId, member.agentId],
    );
  }
}

export async function removeMember(taskId: string, member: { personId?: string; agentId?: string }): Promise<void> {
  await getDb().query(
    "delete from task_members where task_id = $1 and (person_id = $2 or agent_id = $3)",
    [taskId, member.personId ?? null, member.agentId ?? null],
  );
}

/**
 * Adds a message to the thread, with any files attached to it (file version ids), and returns its id.
 * An empty message with nothing attached isn't added (null).
 */
export async function addMessage(
  taskId: string,
  message: { author: string; kind?: TaskMessageKind; body: string; personId?: string; agentId?: string; attachments?: string[] },
): Promise<string | null> {
  const body = message.body.trim();
  if (!body && !message.attachments?.length) return null;
  // An agent's result during its run records how long the run took.
  const [row] = await getDb().query<{ id: string }>(
    `insert into task_messages (task_id, author, kind, body, person_id, agent_id, duration_ms)
     values ($1, $2, $3, $4, $5, $6, case when $3 = 'result' then
       (select (extract(epoch from now() - run_began_at) * 1000)::integer from tasks where id = $1 and run_agent_id = $6)
     end) returning id`,
    [taskId, message.author, message.kind ?? "comment", body, message.personId ?? null, message.agentId ?? null],
  );
  if (message.attachments?.length) await attachToMessage(row.id, message.attachments);
  await getDb().query("update tasks set updated_at = now() where id = $1", [taskId]);
  return row.id;
}

export async function attachToMessage(messageId: string, versionIds: string[]): Promise<void> {
  for (const versionId of versionIds) {
    await getDb().query("insert into task_message_files (message_id, version_id) values ($1, $2) on conflict do nothing", [
      messageId,
      versionId,
    ]);
  }
}

/** Marks a website sign-in as waiting on a person's code (or clears it), dropping any code already given. */
export async function setPendingLogin(taskId: string, slug: string | null): Promise<void> {
  await getDb().query("update tasks set pending_login = $2, login_code = null where id = $1", [taskId, slug]);
}

/** Keeps the (sealed) sign-in code a person replied with until the agent uses it. */
export async function saveLoginCode(taskId: string, sealed: Buffer): Promise<void> {
  await getDb().query("update tasks set login_code = $2 where id = $1", [taskId, sealed]);
}

/** The sealed sign-in code, removed as it's read so it's used once. */
export async function takeLoginCode(taskId: string): Promise<Uint8Array | null> {
  const [row] = await getDb().query<{ code: Uint8Array | null }>(
    "update tasks t set login_code = null from (select login_code from tasks where id = $1 for update) old where t.id = $1 returning old.login_code as code",
    [taskId],
  );
  return row?.code ?? null;
}

export async function saveMemory(taskId: string, memory: string): Promise<void> {
  await getDb().query("update tasks set memory = $2 where id = $1", [taskId, memory]);
}

export async function setSandboxName(taskId: string, name: string | null): Promise<void> {
  await getDb().query("update tasks set sandbox_name = $2 where id = $1", [taskId, name]);
}

/** Retires a job (or brings it back): archived jobs leave every list but keep their files. */
export async function setArchived(organizationId: string, taskId: string, archived: boolean): Promise<void> {
  await getDb().query(
    `update tasks set archived_at = case when $3 then coalesce(archived_at, now()) else null end, updated_at = now()
     where organization_id = $1 and id = $2`,
    [organizationId, taskId, archived],
  );
}

/** A person spoke on the task: agents may hand work to each other again. */
export async function resetAgentTurns(taskId: string): Promise<void> {
  await getDb().query("update tasks set agent_turns = 0 where id = $1", [taskId]);
}

/**
 * Takes the run lease for an agent. Only one run holds a task at a time; a
 * lease older than the timeout is treated as a dead run and can be taken over.
 */
export async function claimRun(
  organizationId: string,
  taskId: string,
  agentId: string,
  activity = "Reading the task",
): Promise<boolean> {
  const rows = await getDb().query(
    `update tasks set run_agent_id = $3, run_started_at = now(), run_began_at = now(), run_activity = $4,
       interrupt_requested_at = null, status = 'in_progress', agent_turns = agent_turns + 1, updated_at = now()
     where organization_id = $1 and id = $2 and status not in ('done', 'cancelled')
       and (run_started_at is null or run_started_at < now() - interval '${LEASE}')
     returning id`,
    [organizationId, taskId, agentId, activity],
  );
  return rows.length > 0;
}

/**
 * Keeps a long run's lease fresh, so it isn't mistaken for a dead one, and says what the agent is doing now.
 * True when someone has asked the run to stop (Send now), so it ends at this step.
 */
export async function renewRun(taskId: string, agentId: string, activity?: string): Promise<boolean> {
  const [row] = await getDb().query<{ interrupted: boolean }>(
    `update tasks set run_started_at = now(), run_activity = coalesce($3, run_activity) where id = $1 and run_agent_id = $2
     returning interrupt_requested_at is not null as interrupted`,
    [taskId, agentId, activity ?? null],
  );
  return row?.interrupted ?? false;
}

/** An agent's reaction to a message a person queued while it worked: it reads it when it finishes what it's doing. */
export const QUEUED = "⏳";

/** Asks the run holding the task to stop at its next step. False if no run holds it. */
export async function requestInterrupt(taskId: string): Promise<boolean> {
  const rows = await getDb().query(
    "update tasks set interrupt_requested_at = now() where id = $1 and run_agent_id is not null returning id",
    [taskId],
  );
  return rows.length > 0;
}

export async function releaseRun(taskId: string, agentId: string): Promise<void> {
  await getDb().query(
    `update tasks set run_agent_id = null, run_started_at = null, run_began_at = null, run_activity = '',
       interrupt_requested_at = null
     where id = $1 and run_agent_id = $2`,
    [taskId, agentId],
  );
}

/** An agent's reaction to messages in a thread (one per agent per message; a new one replaces it). */
export async function reactToMessages(agentId: string, messageIds: string[], emoji: string): Promise<void> {
  if (messageIds.length === 0) return;
  await getDb().query(
    `insert into task_message_reactions (message_id, agent_id, emoji)
     select unnest($1::uuid[]), $2, $3
     on conflict (message_id, agent_id) do update set emoji = excluded.emoji, updated_at = now()`,
    [messageIds, agentId, emoji],
  );
}

/** Where this person's profile suggestions stand, so the chat can show Applied or Dismissed. */
export async function listSuggestionStatuses(organizationId: string, personId: string): Promise<Record<string, TaskStatus>> {
  const rows = await getDb().query<{ id: string; status: TaskStatus }>(
    `select t.id, t.status from tasks t where t.organization_id = $1 and t.kind = 'suggestion' and ${IS_MEMBER}
     order by t.created_at desc limit 200`,
    [organizationId, personId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

/** True while any agent in the organization is working or about to start, so screens know to keep refreshing. */
/** The company's agent runs going now: which task, which agent, and what it's doing. */
export async function listWorking(
  organizationId: string,
): Promise<{ number: number; title: string; agent: string; activity: string; since: Date | null }[]> {
  const rows = await getDb().query<{ number: number; title: string; agent: string; run_activity: string; run_began_at: Date | null }>(
    `select t.number, t.title, a.name as agent, t.run_activity, t.run_began_at
     from tasks t join agents a on a.id = t.run_agent_id
     where t.organization_id = $1 and t.run_started_at > now() - interval '${LEASE}'
     order by t.run_began_at nulls last`,
    [organizationId],
  );
  return rows.map((r) => ({ number: r.number, title: r.title, agent: r.agent, activity: r.run_activity, since: r.run_began_at }));
}

export async function anyRunning(organizationId: string): Promise<boolean> {
  const [row] = await getDb().query<{ running: boolean }>(
    `select exists (
       select 1 from tasks t where t.organization_id = $1 and (
         t.run_started_at > now() - interval '${LEASE}'
         or (t.status = 'ready' and exists (
           select 1 from task_members m join agents a on a.id = m.agent_id where m.task_id = t.id and a.status = 'active'))
       )
     ) as running`,
    [organizationId],
  );
  return row.running;
}

/** How many comments people have written on a task, to notice replies that arrive during an agent run. */
export async function countPersonComments(taskId: string): Promise<number> {
  const [row] = await getDb().query<{ count: number }>(
    "select count(*)::int as count from task_messages where task_id = $1 and person_id is not null and kind = 'comment'",
    [taskId],
  );
  return row.count;
}
