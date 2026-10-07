import "server-only";

import { Cron } from "croner";
import cronstrue from "cronstrue";

import { getDb } from "@/lib/db";

// Recurring jobs. A job can carry one schedule (a cron expression in a
// timezone). Every minute a cron tick (app/api/cron/tick) starts the jobs that
// are due: each run lands on the same card and works in the same sandbox.

export type ScheduleMode = "script" | "agent";

export type Schedule = {
  taskId: string;
  cron: string;
  timezone: string;
  /** script: replay run.sh, waking the agent only if it fails or doesn't exist yet. agent: the agent does the job each time. */
  mode: ScheduleMode;
  paused: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** e.g. "At 16:00, Monday through Friday (Europe/London)". */
  description: string;
};

/** Runs can't be closer together than this. */
export const MIN_INTERVAL_MINUTES = 15;

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone.includes("/") || timezone === "UTC";
  } catch {
    return false;
  }
}

/** Why a schedule can't be used, or null when it's fine. */
export function scheduleProblem(cron: string, timezone: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "Use a five-field cron expression: minute hour day-of-month month day-of-week, e.g. 0 16 * * 1-5.";
  if (!validTimezone(timezone)) return `${timezone} isn't a timezone. Use an IANA name like Europe/London.`;
  let runs: Date[];
  try {
    runs = new Cron(fields.join(" "), { timezone, paused: true }).nextRuns(6);
  } catch (error) {
    return `That cron expression doesn't work: ${error instanceof Error ? error.message : error}`;
  }
  if (runs.length === 0) return "That schedule never runs.";
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60_000) {
      return `Runs must be at least ${MIN_INTERVAL_MINUTES} minutes apart.`;
    }
  }
  return null;
}

/** The first run strictly after `from`. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  return new Cron(cron.trim(), { timezone, paused: true }).nextRun(from);
}

export function describeSchedule(cron: string, timezone: string): string {
  let words = cron;
  try {
    words = cronstrue.toString(cron.trim(), { use24HourTimeFormat: true, verbose: false });
  } catch {}
  return `${words} (${timezone})`;
}

type ScheduleRow = {
  task_id: string;
  cron: string;
  timezone: string;
  mode: ScheduleMode;
  paused: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
};

const toSchedule = (r: ScheduleRow): Schedule => ({
  taskId: r.task_id,
  cron: r.cron,
  timezone: r.timezone,
  mode: r.mode,
  paused: r.paused,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  description: describeSchedule(r.cron, r.timezone),
});

const COLUMNS = "task_id, cron, timezone, mode, paused, next_run_at, last_run_at";

export async function getSchedule(taskId: string): Promise<Schedule | null> {
  const [row] = await getDb().query<ScheduleRow>(`select ${COLUMNS} from task_schedules where task_id = $1`, [taskId]);
  return row ? toSchedule(row) : null;
}

/** Schedules for several jobs at once, for lists. */
export async function schedulesFor(taskIds: string[]): Promise<Map<string, Schedule>> {
  if (taskIds.length === 0) return new Map();
  const rows = await getDb().query<ScheduleRow>(`select ${COLUMNS} from task_schedules where task_id = any($1::uuid[])`, [taskIds]);
  return new Map(rows.map((r) => [r.task_id, toSchedule(r)]));
}

/** Creates or replaces a job's schedule. Callers check scheduleProblem first. */
export async function saveSchedule(
  taskId: string,
  input: { cron: string; timezone: string; mode?: ScheduleMode; by?: { personId?: string; agentId?: string } },
): Promise<Schedule> {
  const cron = input.cron.trim().split(/\s+/).join(" ");
  const problem = scheduleProblem(cron, input.timezone);
  if (problem) throw new Error(problem);
  const [row] = await getDb().query<ScheduleRow>(
    `insert into task_schedules (task_id, cron, timezone, mode, paused, next_run_at, created_by_person_id, created_by_agent_id)
     values ($1, $2, $3, $4, false, $5, $6, $7)
     on conflict (task_id) do update set cron = excluded.cron, timezone = excluded.timezone, mode = excluded.mode,
       paused = false, next_run_at = excluded.next_run_at, updated_at = now()
     returning ${COLUMNS}`,
    [
      taskId,
      cron,
      input.timezone,
      input.mode ?? "script",
      nextRun(cron, input.timezone),
      input.by?.personId ?? null,
      input.by?.agentId ?? null,
    ],
  );
  return toSchedule(row);
}

/** Pauses or resumes. Resuming picks up at the next run from now, without catching up on missed ones. */
export async function setPaused(taskId: string, paused: boolean): Promise<Schedule | null> {
  const schedule = await getSchedule(taskId);
  if (!schedule) return null;
  const [row] = await getDb().query<ScheduleRow>(
    `update task_schedules set paused = $2, next_run_at = $3, updated_at = now() where task_id = $1 returning ${COLUMNS}`,
    [taskId, paused, paused ? schedule.nextRunAt : nextRun(schedule.cron, schedule.timezone)],
  );
  return toSchedule(row);
}

export async function deleteSchedule(taskId: string): Promise<boolean> {
  const rows = await getDb().query("delete from task_schedules where task_id = $1 returning task_id", [taskId]);
  return rows.length > 0;
}

/** Recomputes the next run from now, e.g. when an archived job comes back. */
export async function rescheduleFromNow(taskId: string): Promise<void> {
  const schedule = await getSchedule(taskId);
  if (!schedule) return;
  await getDb().query("update task_schedules set next_run_at = $2 where task_id = $1", [
    taskId,
    nextRun(schedule.cron, schedule.timezone),
  ]);
}

export type DueRun = { taskId: string; organizationId: string; dueAt: Date };

/**
 * Takes the runs that are due: each schedule moves on to its next run from
 * now (missed runs aren't replayed one by one), atomically, so two ticks that
 * overlap never start the same run twice.
 */
export async function takeDueRuns(now = new Date(), limit = 50): Promise<DueRun[]> {
  const db = getDb();
  const due = await db.query<ScheduleRow & { organization_id: string }>(
    `select ${COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")}, t.organization_id
     from task_schedules s join tasks t on t.id = s.task_id
     where not s.paused and s.next_run_at <= $1 and t.archived_at is null and t.status <> 'cancelled'
     order by s.next_run_at limit $2`,
    [now, limit],
  );
  const taken: DueRun[] = [];
  for (const row of due) {
    let next: Date | null = null;
    try {
      next = nextRun(row.cron, row.timezone, now);
    } catch (error) {
      console.error(`Schedule for task ${row.task_id} is broken`, error);
    }
    const claimed = await db.query(
      `update task_schedules set next_run_at = $3, last_run_at = $4, paused = paused or $3::timestamptz is null
       where task_id = $1 and next_run_at = $2 returning task_id`,
      [row.task_id, row.next_run_at, next, now],
    );
    if (claimed.length) taken.push({ taskId: row.task_id, organizationId: row.organization_id, dueAt: row.next_run_at! });
  }
  return taken;
}
