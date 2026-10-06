import "server-only";

import { getDb } from "@/lib/db";
import { emptyProfile } from "@/lib/profile/markdown";

export type Organization = {
  id: string;
  name: string;
  website: string | null;
  onboardingCompletedAt: Date | null;
};

type OrgRow = { id: string; name: string; website: string | null; onboarding_completed_at: Date | null };

const toOrg = (row: OrgRow): Organization => ({
  id: row.id,
  name: row.name,
  website: row.website,
  onboardingCompletedAt: row.onboarding_completed_at,
});

export async function getOrganization(id: string): Promise<Organization | null> {
  const [row] = await getDb().query<OrgRow>(
    "select id, name, website, onboarding_completed_at from organizations where id = $1",
    [id],
  );
  return row ? toOrg(row) : null;
}

/** Creates the organization and its empty profile. Does nothing if it already exists. */
export async function createOrganization(org: { id: string; name: string; website?: string | null }): Promise<void> {
  const db = getDb();
  await db.query("insert into organizations (id, name, website) values ($1, $2, $3) on conflict (id) do nothing", [
    org.id,
    org.name,
    org.website ?? null,
  ]);
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
