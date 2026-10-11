import { getDb } from "@/lib/db";

// Every agent run on a task, as a record of what it did: the skills it had,
// each tool it called (with a script's exit code) and how it ended. A review
// builds its run record from these (lib/learning/record.ts), not from raw
// pages and API responses, which are long and the untrusted part.

export type RunStep = { tool: string; detail: string; ok: boolean; exit?: number };

export type RunLog = {
  taskId: string;
  agentName: string;
  personId: string | null;
  outcome: string;
  skillsPinned: string[];
  skillsLoaded: string[];
  steps: RunStep[];
  modelSteps: number;
  startedAt: Date;
  endedAt: Date;
};

/** What a tool call did, in a line: the activity, and whether it worked (a script's exit code, or a refusal). */
export function stepOf(tool: string, detail: string, result: unknown): RunStep {
  const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
  const exit = text.match(/^exit code (-?\d+)/)?.[1];
  const refused = /^(Not done|Not started|Not saved|Not created|There's no|There is no|The request failed|Couldn't|Error)/i.test(text);
  return { tool, detail, ok: exit !== undefined ? Number(exit) === 0 : !refused, ...(exit !== undefined ? { exit: Number(exit) } : {}) };
}

export async function saveRunLog(organizationId: string, log: Omit<RunLog, "endedAt"> & { agentId: string | null }): Promise<void> {
  await getDb().query(
    `insert into run_log (organization_id, task_id, agent_id, agent_name, person_id, outcome, skills_pinned, skills_loaded, steps, model_steps, started_at)
     values ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10, $11)`,
    [
      organizationId,
      log.taskId,
      log.agentId,
      log.agentName,
      log.personId,
      log.outcome,
      log.skillsPinned,
      log.skillsLoaded,
      JSON.stringify(log.steps.slice(0, 400)),
      log.modelSteps,
      log.startedAt,
    ],
  );
}

/** The runs on these tasks that ended after a time, oldest first. */
export async function listRunLogs(taskIds: string[], since: Date | null): Promise<RunLog[]> {
  if (!taskIds.length) return [];
  const rows = await getDb().query<{
    task_id: string;
    agent_name: string;
    person_id: string | null;
    outcome: string;
    skills_pinned: string[];
    skills_loaded: string[];
    steps: RunStep[];
    model_steps: number;
    started_at: Date;
    ended_at: Date;
  }>(
    `select task_id, agent_name, person_id, outcome, skills_pinned, skills_loaded, steps, model_steps, started_at, ended_at from run_log
     where task_id = any($1::uuid[]) and ($2::timestamptz is null or ended_at > $2) order by ended_at`,
    [taskIds, since],
  );
  return rows.map((r) => ({
    taskId: r.task_id,
    agentName: r.agent_name,
    personId: r.person_id,
    outcome: r.outcome,
    skillsPinned: r.skills_pinned,
    skillsLoaded: r.skills_loaded,
    steps: r.steps,
    modelSteps: r.model_steps,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
}
