import "server-only";

import { getDb } from "@/lib/db";
import { emptyProfile } from "./markdown";

// One markdown document per organization, stored in Postgres.

export async function loadProfile(organizationId: string): Promise<string> {
  const [row] = await getDb().query<{ markdown: string }>(
    "select markdown from company_profiles where organization_id = $1",
    [organizationId],
  );
  return row?.markdown ?? emptyProfile();
}

export async function saveProfile(organizationId: string, markdown: string): Promise<void> {
  await getDb().query(
    `insert into company_profiles (organization_id, markdown, updated_at) values ($1, $2, now())
     on conflict (organization_id) do update set markdown = excluded.markdown, updated_at = now()`,
    [organizationId, markdown],
  );
}

// Tool calls often arrive in parallel, so read-modify-write changes to one
// organization's profile are queued to stop them overwriting each other.
const queues = new Map<string, Promise<unknown>>();

export function updateProfile(organizationId: string, change: (markdown: string) => string): Promise<string> {
  const previous = queues.get(organizationId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const updated = change(await loadProfile(organizationId));
    await saveProfile(organizationId, updated);
    return updated;
  });
  const settled = next.catch(() => undefined);
  queues.set(organizationId, settled);
  settled.then(() => {
    if (queues.get(organizationId) === settled) queues.delete(organizationId);
  });
  return next;
}
