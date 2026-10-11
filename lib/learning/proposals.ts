import "server-only";

import { getIntegration } from "@/lib/integrations";
import { getCompanySkill, saveCompanySkill, type SkillKind } from "@/lib/company-skills";
import { getDb } from "@/lib/db";
import { PEOPLE_SECTION, SECTIONS, setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import { addMessage, createTask, getTask, updateTask, type Task } from "@/lib/tasks";

// What the learner proposes after a review, waiting on a person's yes. All of
// a review's changes go to the person they concern in one message: a card in
// their Needs you, which also wakes their assistant to tell them (on WhatsApp,
// with buttons, while the window is open). They answer in their own words
// ("yes", "just 2", "skip 1"), and their Chief of Staff applies or skips with
// skill.apply_proposal and skill.skip_proposal. Applied changes are a new
// version of the skill or the profile; skipped ones are kept so the learner
// doesn't propose them again.

export type SkillChange = {
  target: "skill";
  name: string;
  isNew: boolean;
  kind: SkillKind;
  description: string;
  body: string;
  scripts?: Record<string, string>;
  extends?: string | null;
  /** For a new integration skill: the integration it's about. */
  integration?: string;
};
export type ProfileChange = { target: "profile"; section: string; content: string };
export type Change = SkillChange | ProfileChange;

export type Draft = { change: Change; why: string; cites: string[] };

export type Proposal = Draft & {
  id: string;
  number: number;
  status: "pending" | "applied" | "skipped" | "replaced";
  personId: string | null;
  taskId: string | null;
  messageTaskId: string | null;
  createdAt: Date;
};

type Row = {
  id: string;
  number: number;
  change: Change;
  why: string;
  cites: string[];
  status: Proposal["status"];
  person_id: string | null;
  task_id: string | null;
  message_task_id: string | null;
  created_at: Date;
};

const toProposal = (r: Row): Proposal => ({
  id: r.id,
  number: r.number,
  change: r.change,
  why: r.why,
  cites: r.cites,
  status: r.status,
  personId: r.person_id,
  taskId: r.task_id,
  messageTaskId: r.message_task_id,
  createdAt: r.created_at,
});

const targetOf = (change: Change) => (change.target === "skill" ? change.name : `profile:${change.section}`);

/** One line per change, numbered, for the message and the Chief of Staff. */
export function describeProposals(proposals: Pick<Proposal, "number" | "change" | "why">[]): string {
  return proposals
    .map((p) => `${p.number}) ${p.why} (${p.change.target === "skill" ? `${p.change.isNew ? "new skill" : "skill"} ${p.change.name}` : `profile: ${p.change.section}`})`)
    .join("\n");
}

/**
 * Saves a review's changes and sends them to the person in one message. An
 * older change to the same skill still waiting is replaced by this one.
 */
export async function proposeChanges(
  organizationId: string,
  input: { reviewId: string; task: Task; personId: string; drafts: Draft[] },
): Promise<Proposal[]> {
  const db = getDb();
  const targets = input.drafts.map((d) => targetOf(d.change));
  const replaced = await db.query<{ message_task_id: string | null }>(
    `update skill_proposals set status = 'replaced', decided_at = now()
     where organization_id = $1 and status = 'pending' and (case when target = 'skill' then skill_name else 'profile:' || skill_name end) = any($2::text[])
     returning message_task_id`,
    [organizationId, targets],
  );
  const saved: Proposal[] = [];
  for (const [i, draft] of input.drafts.entries()) {
    const [row] = await db.query<Row>(
      `insert into skill_proposals (organization_id, review_id, task_id, number, target, skill_name, change, why, cites, person_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], $10)
       returning id, number, change, why, cites, status, person_id, task_id, message_task_id, created_at`,
      [
        organizationId,
        input.reviewId,
        input.task.id,
        i + 1,
        draft.change.target,
        draft.change.target === "skill" ? draft.change.name : draft.change.section,
        JSON.stringify(draft.change),
        draft.why,
        draft.cites,
        input.personId,
      ],
    );
    saved.push(toProposal(row));
  }
  const message = await createTask(organizationId, {
    kind: "suggestion",
    title: `${saved.length === 1 ? "A change" : `${saved.length} changes`} from #${input.task.number}`,
    description: `From "${input.task.title}" (#${input.task.number}), Mach1 proposes:\n${describeProposals(saved)}`,
    summary: saved.length === 1 ? `${saved[0].why} Apply it?` : `${saved.length} changes from #${input.task.number}. Apply them?`,
    status: "ready",
    payload: { proposals: true, review: input.reviewId },
    options: [
      { label: "Apply all", recommended: true },
      { label: "Skip all", recommended: false },
    ],
    people: [input.personId],
    visibility: "private",
    createdBy: { personId: input.personId },
  });
  await db.query("update skill_proposals set message_task_id = $2 where id = any($1::uuid[])", [saved.map((p) => p.id), message.id]);
  await addMessage(message.id, { author: "Mach1", kind: "result", body: message.description });
  // Ready for them now: a notification, and their assistant wakes to tell them.
  await updateTask(organizationId, message.id, { status: "review" });
  // Older messages whose every change was replaced are done with.
  for (const { message_task_id: id } of replaced) if (id) await closeIfDecided(organizationId, id);
  return saved.map((p) => ({ ...p, messageTaskId: message.id }));
}

/** Changes waiting on a person, oldest message first. */
export async function pendingProposals(organizationId: string, personId: string): Promise<(Proposal & { messageNumber: number | null })[]> {
  const rows = await getDb().query<Row & { message_number: number | null }>(
    `select p.id, p.number, p.change, p.why, p.cites, p.status, p.person_id, p.task_id, p.message_task_id, p.created_at, m.number as message_number
     from skill_proposals p left join tasks m on m.id = p.message_task_id
     where p.organization_id = $1 and p.person_id = $2 and p.status = 'pending' order by p.created_at, p.number`,
    [organizationId, personId],
  );
  return rows.map((r) => ({ ...toProposal(r), messageNumber: r.message_number }));
}

/** The changes on one message (its card in Needs you). */
export async function proposalsOn(organizationId: string, messageTaskId: string): Promise<Proposal[]> {
  const rows = await getDb().query<Row>(
    `select id, number, change, why, cites, status, person_id, task_id, message_task_id, created_at from skill_proposals
     where organization_id = $1 and message_task_id = $2 order by number`,
    [organizationId, messageTaskId],
  );
  return rows.map(toProposal);
}

/** Changes people skipped on these skills before, so the learner doesn't propose them again. */
export async function skippedBefore(organizationId: string, targets: string[]): Promise<Proposal[]> {
  if (!targets.length) return [];
  const rows = await getDb().query<Row>(
    `select id, number, change, why, cites, status, person_id, task_id, message_task_id, created_at from skill_proposals
     where organization_id = $1 and status = 'skipped' and skill_name = any($2::text[]) order by decided_at desc limit 20`,
    [organizationId, targets],
  );
  return rows.map(toProposal);
}

/** Applies one change as a new version of its skill, or of the profile. */
export async function applyChange(
  organizationId: string,
  proposal: Proposal,
  by: { name: string; personId?: string | null },
  source: Pick<Task, "id" | "visibility" | "createdByPersonId"> | null,
): Promise<string> {
  const change = proposal.change;
  if (change.target === "profile") {
    const section = SECTIONS.find((s) => s.toLowerCase() === change.section.toLowerCase());
    if (!section || section === PEOPLE_SECTION) throw new ProposalError(`The profile has no ${change.section} section to change.`);
    await updateProfile(organizationId, (markdown) => setSection(markdown, section, change.content));
    return `the profile's ${section}`;
  }
  const existing = await getCompanySkill(organizationId, change.name);
  const integration = change.integration && !existing ? await getIntegration(organizationId, change.integration) : null;
  const saved = await saveCompanySkill(organizationId, {
    name: change.name,
    description: change.description,
    body: change.body,
    kind: existing?.kind ?? change.kind,
    extends: change.extends === undefined ? existing?.extends : change.extends,
    scripts: change.scripts ?? existing?.scripts,
    tools: existing?.tools,
    model: existing?.model,
    integrationId: existing?.integrationId ?? integration?.id ?? null,
    // A new skill is the person's it was learned for, shared as the work was; a system's is the company's.
    ownerPersonId: existing ? existing.ownerPersonId : change.kind === "integration" ? null : (proposal.personId ?? source?.createdByPersonId ?? null),
    visibility: existing ? existing.visibility : change.kind === "integration" || source?.visibility === "company" ? "company" : "private",
    note: proposal.why,
    by: { name: `${by.name}, from Mach1's review`, personId: by.personId },
    sourceTaskId: proposal.taskId,
  });
  return `${saved.name} (version ${saved.version})`;
}

export class ProposalError extends Error {}

/** Records a person's decision on a change. */
export async function decide(proposalId: string, status: "applied" | "skipped", by: string): Promise<void> {
  await getDb().query("update skill_proposals set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = 'pending'", [
    proposalId,
    status,
    by,
  ]);
}

/** A message whose every change has been decided (or replaced) is done. */
export async function closeIfDecided(organizationId: string, messageTaskId: string): Promise<void> {
  const left = (await proposalsOn(organizationId, messageTaskId)).filter((p) => p.status === "pending");
  if (left.length) return;
  const message = await getTask(organizationId, messageTaskId);
  if (message && message.status !== "done") await updateTask(organizationId, messageTaskId, { status: "done", options: [] });
}
