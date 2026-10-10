import "server-only";

import { DEFAULT_HOURS, deliverAt, validHours, type WorkHours } from "@/lib/assistant/hours";
import { getDb } from "@/lib/db";

// What a person's assistant keeps to message them at the right moments:
// their hours, when they last wrote on WhatsApp and when it last wrote first,
// and the wake-ups waiting for it (see wake.ts).

export type AssistantHours = {
  timezone: string;
  hours: WorkHours;
  /** False until they (or their assistant, on their word) saved their own hours: the company's timezone and office hours stand in. */
  saved: boolean;
};

export type WakeReason = "task" | "check_in" | "keepalive";

export type Wakeup = {
  id: string;
  organizationId: string;
  personId: string;
  reason: WakeReason;
  note: string;
  taskId: string | null;
  urgent: boolean;
  dueAt: Date;
};

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function getAssistantHours(organizationId: string, personId: string): Promise<AssistantHours> {
  const [row] = await getDb().query<{ timezone: string | null; work_hours: Partial<WorkHours> | null; org_timezone: string | null }>(
    `select p.timezone, p.work_hours, o.timezone as org_timezone from people p join organizations o on o.id = p.organization_id
     where p.organization_id = $1 and p.id = $2`,
    [organizationId, personId],
  );
  const timezone = [row?.timezone, row?.org_timezone].find((tz): tz is string => Boolean(tz && validTimezone(tz))) ?? "UTC";
  return { timezone, hours: row?.work_hours ? validHours(row.work_hours) : DEFAULT_HOURS, saved: Boolean(row?.timezone && row.work_hours) };
}

export async function saveAssistantHours(organizationId: string, personId: string, timezone: string, hours: Partial<WorkHours>): Promise<AssistantHours> {
  if (!validTimezone(timezone)) throw new Error(`${timezone} isn't a timezone. Use a name like Europe/London.`);
  const clean = validHours(hours);
  await getDb().query("update people set timezone = $3, work_hours = $4::jsonb, updated_at = now() where organization_id = $1 and id = $2", [
    organizationId,
    personId,
    timezone,
    JSON.stringify(clean),
  ]);
  return { timezone, hours: clean, saved: true };
}

/** They just wrote on WhatsApp: the 24 hours in which their assistant may write freely start again. */
export async function recordWhatsAppIn(organizationId: string, personId: string): Promise<void> {
  await getDb().query("update people set whatsapp_in_at = now() where organization_id = $1 and id = $2", [organizationId, personId]);
}

/** Their assistant just wrote to them unprompted. */
export async function recordNudge(organizationId: string, personId: string): Promise<void> {
  await getDb().query("update people set assistant_nudged_at = now() where organization_id = $1 and id = $2", [organizationId, personId]);
}

export async function whatsAppWindow(organizationId: string, personId: string): Promise<{ lastIn: Date | null; lastNudge: Date | null }> {
  const [row] = await getDb().query<{ whatsapp_in_at: Date | null; assistant_nudged_at: Date | null }>(
    "select whatsapp_in_at, assistant_nudged_at from people where organization_id = $1 and id = $2",
    [organizationId, personId],
  );
  return { lastIn: row?.whatsapp_in_at ?? null, lastNudge: row?.assistant_nudged_at ?? null };
}

/**
 * Wakes their assistant later. `at` is moved out of their quiet hours, and,
 * unless it's urgent, into their working hours. A task has at most one
 * waiting wake-up per person: a newer one replaces it.
 */
export async function scheduleWakeup(
  organizationId: string,
  personId: string,
  wake: { reason: WakeReason; note?: string; taskId?: string | null; urgent?: boolean; at?: Date },
): Promise<Date> {
  const { timezone, hours } = await getAssistantHours(organizationId, personId);
  const urgent = wake.urgent ?? false;
  const dueAt = deliverAt(wake.at ?? new Date(), timezone, hours, { urgent });
  const db = getDb();
  if (wake.taskId) {
    await db.query("delete from assistant_wakeups where person_id = $1 and task_id = $2 and done_at is null and claimed_at is null", [
      personId,
      wake.taskId,
    ]);
  }
  await db.query(
    `insert into assistant_wakeups (organization_id, person_id, reason, note, task_id, urgent, due_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [organizationId, personId, wake.reason, (wake.note ?? "").slice(0, 1000), wake.taskId ?? null, urgent, dueAt],
  );
  return dueAt;
}

type WakeupRow = {
  id: string;
  organization_id: string;
  person_id: string;
  reason: WakeReason;
  note: string;
  task_id: string | null;
  urgent: boolean;
  due_at: Date;
};

const toWakeup = (r: WakeupRow): Wakeup => ({
  id: r.id,
  organizationId: r.organization_id,
  personId: r.person_id,
  reason: r.reason,
  note: r.note,
  taskId: r.task_id,
  urgent: r.urgent,
  dueAt: r.due_at,
});

/** How long a claimed wake-up stays with the tick that claimed it: longer than any turn runs. */
const CLAIM_LEASE = "20 minutes";

/**
 * The wake-ups that are due, claimed for this tick and grouped by person
 * (a person's assistant wakes once for everything due). A person with one
 * claimed by another tick is left to it.
 */
export async function claimDueWakeups(limit = 20): Promise<Wakeup[][]> {
  const rows = await getDb().query<WakeupRow>(
    `update assistant_wakeups set claimed_at = now()
     where done_at is null and due_at <= now() and (claimed_at is null or claimed_at < now() - interval '${CLAIM_LEASE}')
       and person_id in (
         select person_id from assistant_wakeups
         where done_at is null and due_at <= now() and (claimed_at is null or claimed_at < now() - interval '${CLAIM_LEASE}')
         group by person_id order by min(due_at) limit $1
       )
       and person_id not in (
         select person_id from assistant_wakeups where done_at is null and claimed_at >= now() - interval '${CLAIM_LEASE}'
       )
     returning id, organization_id, person_id, reason, note, task_id, urgent, due_at`,
    [limit],
  );
  const byPerson = new Map<string, Wakeup[]>();
  for (const row of rows) byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), toWakeup(row)]);
  return [...byPerson.values()].map((list) => list.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()));
}

export async function finishWakeups(ids: string[]): Promise<void> {
  await getDb().query("update assistant_wakeups set done_at = now() where id = any($1::uuid[])", [ids]);
}

/** Tries again a little later (they were mid-conversation, or the turn failed). */
export async function postponeWakeups(ids: string[], minutes: number): Promise<void> {
  await getDb().query(
    `update assistant_wakeups set claimed_at = null, due_at = now() + make_interval(mins => $2) where id = any($1::uuid[])`,
    [ids, minutes],
  );
}

/**
 * People whose WhatsApp window is open, who haven't heard from their
 * assistant since they last wrote, with nothing else waking it before the
 * window closes and no keep-alive tried since: the candidates for one now
 * (keepAliveDue decides when).
 */
export async function keepAliveCandidates(): Promise<{ organizationId: string; personId: string; lastIn: Date; lastNudge: Date | null }[]> {
  const rows = await getDb().query<{ organization_id: string; id: string; whatsapp_in_at: Date; assistant_nudged_at: Date | null }>(
    `select p.organization_id, p.id, p.whatsapp_in_at, p.assistant_nudged_at from people p
     where p.status = 'active' and p.workos_user_id is not null and p.whatsapp is not null
       and p.whatsapp_in_at > now() - interval '24 hours'
       and (p.assistant_nudged_at is null or p.assistant_nudged_at < p.whatsapp_in_at)
       and not exists (
         select 1 from assistant_wakeups w where w.person_id = p.id and (
           (w.done_at is null and w.due_at < p.whatsapp_in_at + interval '24 hours')
           or (w.reason = 'keepalive' and w.created_at > p.whatsapp_in_at)
         )
       )`,
  );
  return rows.map((r) => ({ organizationId: r.organization_id, personId: r.id, lastIn: r.whatsapp_in_at, lastNudge: r.assistant_nudged_at }));
}
