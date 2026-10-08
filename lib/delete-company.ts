import "server-only";

import { agentmailConfigured, deleteInbox } from "@/lib/channels/agentmail";
import { getDb } from "@/lib/db";
import { sandboxes, sandboxNameFor, workspaceSandboxName } from "@/lib/sandbox";
import { removePrefix } from "@/lib/storage";

// Deleting a company deletes everything it has in Mach: its job sandboxes and
// the Chief of Staff's workspace sandbox, every file it stored in Blob (the
// library, the drive, uploads), every row in the database (the organization
// row cascades to people, chats, agents, tasks, files, integrations and their
// credentials, schedules), its Chief of Staff's email inbox, and its WorkOS organization (memberships and
// invitations). People's WorkOS accounts stay: they may belong to other
// companies.

/** Everything a company stores in Blob lives under this prefix. */
export const companyPrefix = (organizationId: string) => `orgs/${organizationId}/`;

export type DeletedCompany = { sandboxes: number; files: number; problems: string[] };

/**
 * The company's sandboxes: every job's that has one, and the workspace. `live`
 * are the ones an agent run going (or about to start) might still create.
 */
async function sandboxNames(organizationId: string): Promise<{ all: string[]; live: string[] }> {
  const rows = await getDb().query<{ id: string; sandbox_name: string | null; live: boolean }>(
    `select id, sandbox_name, (run_started_at > now() - interval '15 minutes' or status = 'ready') as live
     from tasks where organization_id = $1 and (sandbox_name is not null or run_started_at is not null or status = 'ready')`,
    [organizationId],
  );
  const workspace = workspaceSandboxName(organizationId);
  const live = [...rows.filter((r) => r.live).map((r) => sandboxNameFor(r.id)), workspace];
  return { all: [...new Set([...rows.flatMap((r) => (r.sandbox_name ? [r.sandbox_name] : [])), ...live])], live };
}

async function removeSandboxes(names: string[]): Promise<number> {
  // A few at a time: each is a call to Vercel.
  for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map((name) => sandboxes().remove(name)));
  return names.length;
}

/**
 * Deletes the company and everything it owns. External things go first, so a
 * failure there stops before the company's records are gone and the delete
 * can be retried. Once the records are deleted, agent runs still in flight
 * can't start new sandboxes (sandbox steps check the company exists); a last
 * sweep catches anything they stored meanwhile, and WorkOS goes last.
 */
export async function deleteCompany(
  organizationId: string,
  { removeFromWorkOS }: { removeFromWorkOS: (organizationId: string) => Promise<void> },
): Promise<DeletedCompany> {
  const prefix = companyPrefix(organizationId);
  const names = await sandboxNames(organizationId);
  const removedSandboxes = await removeSandboxes(names.all);
  // The Chief of Staff's email address.
  const [org] = await getDb().query<{ email_inbox: string | null }>("select email_inbox from organizations where id = $1", [organizationId]);
  if (org?.email_inbox && agentmailConfigured()) await deleteInbox(org.email_inbox);
  let files = await removePrefix(prefix);

  await getDb().query("delete from organizations where id = $1", [organizationId]);

  // Best effort from here: the company is gone, so report problems rather than fail.
  const problems: string[] = [];
  try {
    await removeSandboxes(names.live);
    files += await removePrefix(prefix);
  } catch (error) {
    problems.push(`Cleanup after deleting the records: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await removeFromWorkOS(organizationId);
  } catch (error) {
    problems.push(`WorkOS organization: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const problem of problems) console.error(`Deleting ${organizationId}: ${problem}`);
  return { sandboxes: removedSandboxes, files, problems };
}
