import "server-only";

import { getDb } from "@/lib/db";
import { emptyProfile } from "@/lib/profile/markdown";

export type Organization = {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  /** IANA name, e.g. Europe/London, for schedules. */
  timezone: string | null;
  onboardingCompletedAt: Date | null;
  /** The Chief of Staff's email address for the company (an AgentMail inbox), if one was set up. */
  emailInbox: string | null;
  /** The company's own choice of models (AI Gateway ids), over Mach1's defaults. */
  models: CompanyModels;
  /** Jobs estimated above this many dollars a round need a person's approval of the plan first (null: no limit). */
  jobCostLimit: number | null;
};

export type CompanyModels = { chiefOfStaff?: string; agents?: string };

type OrgRow = {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  timezone: string | null;
  onboarding_completed_at: Date | null;
  email_inbox: string | null;
  models: CompanyModels | null;
  job_cost_limit: number | null;
};

const ORG_COLUMNS = "id, name, website, domain, timezone, onboarding_completed_at, email_inbox, models, job_cost_limit";

const toOrg = (row: OrgRow): Organization => ({
  id: row.id,
  name: row.name,
  website: row.website,
  domain: row.domain,
  timezone: row.timezone,
  onboardingCompletedAt: row.onboarding_completed_at,
  emailInbox: row.email_inbox,
  models: row.models ?? {},
  jobCostLimit: row.job_cost_limit,
});

export async function getOrganization(id: string): Promise<Organization | null> {
  const [row] = await getDb().query<OrgRow>(`select ${ORG_COLUMNS} from organizations where id = $1`, [id]);
  return row ? toOrg(row) : null;
}

/** Creates the organization and its empty profile. Does nothing if it already exists. */
export async function createOrganization(org: {
  id: string;
  name: string;
  website?: string | null;
}): Promise<void> {
  const db = getDb();
  await db.query(
    "insert into organizations (id, name, website) values ($1, $2, $3) on conflict (id) do nothing",
    [org.id, org.name, org.website ?? null],
  );
  await db.query(
    "insert into company_profiles (organization_id, markdown) values ($1, $2) on conflict (organization_id) do nothing",
    [org.id, emptyProfile(org.name)],
  );
}

export async function renameOrganization(id: string, name: string): Promise<void> {
  await getDb().query("update organizations set name = $2 where id = $1", [id, name]);
}

export async function completeOnboarding(id: string): Promise<void> {
  await getDb().query(
    "update organizations set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1",
    [id],
  );
}

/** Records the company's timezone the first time a browser reports one; later changes are explicit. */
export async function rememberTimezone(id: string, timezone: string, { replace = false } = {}): Promise<void> {
  await getDb().query(
    `update organizations set timezone = $2 where id = $1 and ($3 or timezone is null)`,
    [id, timezone, replace],
  );
}

export async function setEmailInbox(organizationId: string, inbox: string | null): Promise<void> {
  await getDb().query("update organizations set email_inbox = $2 where id = $1", [organizationId, inbox]);
}

export async function findOrganizationByInbox(inbox: string): Promise<Organization | null> {
  const [row] = await getDb().query<OrgRow>(`select ${ORG_COLUMNS} from organizations where lower(email_inbox) = lower($1)`, [inbox]);
  return row ? toOrg(row) : null;
}

/** The dollars a job's round may be estimated at before a person approves its plan; null for no limit. */
export async function setJobCostLimit(id: string, limit: number | null): Promise<void> {
  await getDb().query("update organizations set job_cost_limit = $2 where id = $1", [id, limit]);
}

/** The company's own default models; an empty one goes back to Mach1's. */
export async function setCompanyModels(id: string, models: CompanyModels): Promise<void> {
  const clean = Object.fromEntries(Object.entries(models).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v!.trim()]));
  await getDb().query("update organizations set models = $2::jsonb where id = $1", [id, JSON.stringify(clean)]);
}
