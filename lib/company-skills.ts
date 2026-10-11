import "server-only";

import type { Skill } from "@/lib/agents/skills";
import { SKILL_TOOLS, getSkill } from "@/lib/agents/skills";
import { ROLES, type Role } from "@/lib/ai/lineup";
import { getDb } from "@/lib/db";

// Company skills (docs/agent-design.md): how this company does a piece of
// work, and how its systems work, learned on the job or written by people.
// Base skills are Mach1's, in the repo (lib/agents/skills.ts); these live in
// Postgres. Every change is a new version, and restoring one makes it the
// newest again, so nothing is ever lost. A skill is the company's, or one
// person's (private ones only they see, like tasks).

export type SkillKind = "workflow" | "integration";
export type SkillVisibility = "company" | "private";

export type CompanySkill = {
  id: string;
  name: string;
  kind: SkillKind;
  integrationId: string | null;
  /** Null for the company's own; otherwise the person it belongs to. */
  ownerPersonId: string | null;
  ownerName: string | null;
  visibility: SkillVisibility;
  version: number;
  description: string;
  body: string;
  tools: string[];
  model: Role | null;
  extends: string | null;
  /** Its scripts, by path under the skill's folder (code/pull.py, test/pull.json). */
  scripts: Record<string, string>;
  updatedAt: Date;
};

export type SkillVersion = {
  version: number;
  description: string;
  note: string;
  author: string;
  sourceTaskNumber: number | null;
  createdAt: Date;
};

export class SkillError extends Error {}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

type Row = {
  id: string;
  name: string;
  kind: SkillKind;
  integration_id: string | null;
  owner_person_id: string | null;
  owner_name: string | null;
  visibility: SkillVisibility;
  version: number;
  description: string;
  body: string;
  tools: string[] | null;
  model: Role | null;
  extends: string | null;
  scripts: Record<string, string> | null;
  updated_at: Date;
};

const COLUMNS = `s.id, s.name, s.kind, s.integration_id, s.owner_person_id, p.name as owner_name, s.visibility, s.version,
  v.description, v.body, v.tools, v.model, v.extends, v.scripts, s.updated_at`;
const FROM = `skills s join skill_versions v on v.skill_id = s.id and v.version = s.version
  left join people p on p.id = s.owner_person_id`;
/** Visible to a viewer: the company's, and their own private ones. No viewer: the company's only. */
const VISIBLE = `(s.visibility = 'company' or s.owner_person_id = $2)`;

const toSkill = (r: Row): CompanySkill => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  integrationId: r.integration_id,
  ownerPersonId: r.owner_person_id,
  ownerName: r.owner_name,
  visibility: r.visibility,
  version: r.version,
  description: r.description,
  body: r.body,
  tools: r.tools ?? [],
  model: r.model,
  extends: r.extends,
  scripts: r.scripts ?? {},
  updatedAt: r.updated_at,
});

/** The company's skills a person may see (theirs and the company's); with no person, the company's only. */
export async function listCompanySkills(organizationId: string, { viewer }: { viewer?: string | null } = {}): Promise<CompanySkill[]> {
  const rows = await getDb().query<Row>(
    `select ${COLUMNS} from ${FROM} where s.organization_id = $1 and s.archived_at is null and ${VISIBLE} order by s.name`,
    [organizationId, viewer ?? null],
  );
  return rows.map(toSkill);
}

export async function getCompanySkill(organizationId: string, name: string, { viewer }: { viewer?: string | null } = {}): Promise<CompanySkill | null> {
  const [row] = await getDb().query<Row>(
    `select ${COLUMNS} from ${FROM} where s.organization_id = $1 and s.archived_at is null and ${VISIBLE} and s.name = $3`,
    [organizationId, viewer ?? null, name.trim().toLowerCase()],
  );
  return row ? toSkill(row) : null;
}

/** A company skill as agents read it, alongside the base skills. */
export const asSkill = (c: CompanySkill): Skill => ({
  name: c.name,
  description: c.description,
  body: c.body,
  ...(c.tools.length ? { tools: c.tools } : {}),
  ...(c.model ? { model: c.model } : {}),
  ...(c.extends ? { extends: c.extends } : {}),
  ...(Object.keys(c.scripts).length ? { scripts: c.scripts } : {}),
  company: { kind: c.kind, version: c.version, owner: c.ownerName },
});

/** Every skill an agent working for this person may load: Mach1's and the company's they may see. */
export async function companySkillsFor(organizationId: string, personId?: string | null): Promise<Skill[]> {
  return (await listCompanySkills(organizationId, { viewer: personId })).map(asSkill);
}

export type SkillDraft = {
  name: string;
  description: string;
  body: string;
  kind?: SkillKind;
  tools?: string[];
  model?: Role | null;
  extends?: string | null;
  scripts?: Record<string, string>;
};

/** What makes a draft unusable, said for a person: a bad name, a base skill's name, unknown tools. */
export function draftProblem(draft: SkillDraft): string | null {
  const name = draft.name.trim();
  if (!NAME.test(name)) return "A skill's name is lowercase words joined by dashes, e.g. masttro-weekly-tagging.";
  if (getSkill(name)) return `${name} is one of Mach1's own skills. Write one that extends it instead.`;
  if (!draft.description.trim()) return "A skill needs a one-line description of when to use it.";
  if (!draft.body.trim()) return "A skill needs its steps.";
  if (draft.extends && !getSkill(draft.extends)) return `There's no Mach1 skill called ${draft.extends} to extend.`;
  const unknown = (draft.tools ?? []).filter((t) => !SKILL_TOOLS.has(t));
  if (unknown.length) return `A skill can only switch on ${[...SKILL_TOOLS].join(", ")}, not ${unknown.join(", ")}.`;
  if (draft.model && !(ROLES as readonly string[]).includes(draft.model)) return `${draft.model} isn't a model role.`;
  if (Object.keys(draft.scripts ?? {}).some((p) => p.startsWith("/") || p.includes(".."))) return "Script paths stay inside the skill's folder.";
  return null;
}

/**
 * Saves a skill: a new one, or the next version of one that exists. Who may
 * is checked by the caller (lib/operations.ts); here it's only what's saved.
 */
export async function saveCompanySkill(
  organizationId: string,
  draft: SkillDraft & {
    ownerPersonId?: string | null;
    visibility?: SkillVisibility;
    integrationId?: string | null;
    note?: string;
    by: { name: string; personId?: string | null };
    sourceTaskId?: string | null;
  },
): Promise<CompanySkill> {
  const problem = draftProblem(draft);
  if (problem) throw new SkillError(problem);
  const name = draft.name.trim();
  const db = getDb();
  const [existing] = await db.query<{ id: string; version: number }>(
    "select id, (select max(version) from skill_versions where skill_id = skills.id) as version from skills where organization_id = $1 and name = $2 and archived_at is null",
    [organizationId, name],
  );
  let id = existing?.id;
  const version = (existing?.version ?? 0) + 1;
  if (!id) {
    const [row] = await db.query<{ id: string }>(
      `insert into skills (organization_id, name, kind, integration_id, owner_person_id, visibility)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [organizationId, name, draft.kind ?? "workflow", draft.integrationId ?? null, draft.ownerPersonId ?? null, draft.visibility ?? "company"],
    );
    id = row.id;
  }
  await db.query(
    `insert into skill_versions (skill_id, version, description, body, tools, model, extends, scripts, note, author, author_person_id, source_task_id)
     values ($1, $2, $3, $4, $5::text[], $6, $7, $8::jsonb, $9, $10, $11, $12)`,
    [
      id,
      version,
      draft.description.trim(),
      draft.body.trim(),
      [...new Set(draft.tools ?? [])],
      draft.model ?? null,
      draft.extends ?? null,
      JSON.stringify(draft.scripts ?? {}),
      draft.note?.trim() ?? "",
      draft.by.name,
      draft.by.personId ?? null,
      draft.sourceTaskId ?? null,
    ],
  );
  await db.query("update skills set version = $2, updated_at = now() where id = $1", [id, version]);
  return (await getCompanySkill(organizationId, name, { viewer: draft.ownerPersonId }))!;
}

/** A skill's versions, newest first. */
export async function listSkillVersions(skillId: string): Promise<SkillVersion[]> {
  const rows = await getDb().query<{ version: number; description: string; note: string; author: string; number: number | null; created_at: Date }>(
    `select v.version, v.description, v.note, v.author, t.number, v.created_at from skill_versions v
     left join tasks t on t.id = v.source_task_id where v.skill_id = $1 order by v.version desc`,
    [skillId],
  );
  return rows.map((r) => ({ version: r.version, description: r.description, note: r.note, author: r.author, sourceTaskNumber: r.number, createdAt: r.created_at }));
}

/** Makes an earlier version the newest again (as a new version, so the one it replaces stays restorable). */
export async function restoreSkillVersion(organizationId: string, skill: CompanySkill, version: number, by: { name: string; personId?: string | null }): Promise<CompanySkill> {
  const [old] = await getDb().query<{ description: string; body: string; tools: string[]; model: Role | null; extends: string | null; scripts: Record<string, string> }>(
    "select description, body, tools, model, extends, scripts from skill_versions where skill_id = $1 and version = $2",
    [skill.id, version],
  );
  if (!old) throw new SkillError(`${skill.name} has no version ${version}.`);
  return saveCompanySkill(organizationId, {
    name: skill.name,
    ...old,
    ownerPersonId: skill.ownerPersonId,
    note: `Restored version ${version}.`,
    by,
  });
}

/** Shares a person's skill with the company, or makes it theirs alone. */
export async function setSkillVisibility(skillId: string, visibility: SkillVisibility): Promise<void> {
  await getDb().query("update skills set visibility = $2, updated_at = now() where id = $1", [skillId, visibility]);
}

/** Retires a skill: agents stop seeing it. Its versions are kept. */
export async function archiveSkill(skillId: string): Promise<void> {
  await getDb().query("update skills set archived_at = now(), updated_at = now() where id = $1", [skillId]);
}
