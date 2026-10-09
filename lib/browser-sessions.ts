import type { ModelMessage } from "ai";

import { getDb } from "@/lib/db";

// Conversations with the browser agent (see lib/agents/browser-agent.ts). The
// history is kept without screenshots: the agent looks again when it resumes.

export type BrowserSessionStatus = "working" | "done" | "needs_input" | "blocked" | "failed";

export type BrowserSession = {
  id: string;
  taskId: string | null;
  goal: string;
  messages: ModelMessage[];
  status: BrowserSessionStatus;
  login: string | null;
};

type Row = { id: string; task_id: string | null; goal: string; messages: ModelMessage[]; status: BrowserSessionStatus; login: string | null };

const toSession = (r: Row): BrowserSession => ({ id: r.id, taskId: r.task_id, goal: r.goal, messages: r.messages, status: r.status, login: r.login });

export async function createBrowserSession(
  organizationId: string,
  input: { taskId: string | null; personId?: string | null; goal: string },
): Promise<BrowserSession> {
  const [row] = await getDb().query<Row>(
    `insert into browser_sessions (organization_id, task_id, person_id, goal) values ($1, $2, $3, $4)
     returning id, task_id, goal, messages, status, login`,
    [organizationId, input.taskId, input.taskId ? null : (input.personId ?? null), input.goal],
  );
  return toSession(row);
}

/**
 * A session of this company's: on this task, or (for the Chief of Staff, no
 * task) one started in this person's own chat.
 */
export async function getBrowserSession(
  organizationId: string,
  id: string,
  owner: { taskId: string | null; personId?: string | null },
): Promise<BrowserSession | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await getDb().query<Row>(
    `select id, task_id, goal, messages, status, login from browser_sessions
     where organization_id = $1 and id = $2 and task_id is not distinct from $3
       and ($3::uuid is not null or person_id is not distinct from $4::uuid)`,
    [organizationId, id, owner.taskId, owner.taskId ? null : (owner.personId ?? null)],
  );
  return row ? toSession(row) : null;
}

export async function saveBrowserSession(
  id: string,
  patch: { messages: ModelMessage[]; status: BrowserSessionStatus; login?: string | null },
): Promise<void> {
  await getDb().query(
    "update browser_sessions set messages = $2::jsonb, status = $3, login = coalesce($4, login), updated_at = now() where id = $1",
    [id, JSON.stringify(patch.messages), patch.status, patch.login ?? null],
  );
}
