import "server-only";

import { getDb } from "@/lib/db";
import { PEOPLE_SECTION, renderPeople, setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";

// Everyone in an organization's org chart. A person can exist without a login
// ("not_invited"), have an outstanding WorkOS invitation ("invited"), or be a
// signed-in member ("active").

export type PersonStatus = "not_invited" | "invited" | "active";

export type Person = {
  id: string;
  name: string;
  role: string;
  responsibilities: string;
  email: string | null;
  phone: string | null;
  managerId: string | null;
  managerName: string | null;
  status: PersonStatus;
  workosUserId: string | null;
  invitationId: string | null;
  inviteUrl: string | null;
};

type PersonRow = {
  id: string;
  name: string;
  role: string;
  responsibilities: string;
  email: string | null;
  phone: string | null;
  manager_id: string | null;
  manager_name: string | null;
  status: PersonStatus;
  workos_user_id: string | null;
  workos_invitation_id: string | null;
  invite_url: string | null;
};

const SELECT_PEOPLE = `
  select p.id, p.name, p.role, p.responsibilities, p.email, p.phone, p.manager_id, m.name as manager_name,
         p.status, p.workos_user_id, p.workos_invitation_id, p.invite_url
  from people p left join people m on m.id = p.manager_id`;

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  name: r.name,
  role: r.role,
  responsibilities: r.responsibilities,
  email: r.email,
  phone: r.phone,
  managerId: r.manager_id,
  managerName: r.manager_name,
  status: r.status,
  workosUserId: r.workos_user_id,
  invitationId: r.workos_invitation_id,
  inviteUrl: r.invite_url,
});

export async function listPeople(organizationId: string): Promise<Person[]> {
  const rows = await getDb().query<PersonRow>(`${SELECT_PEOPLE} where p.organization_id = $1 order by p.created_at`, [
    organizationId,
  ]);
  return rows.map(toPerson);
}

export async function getPerson(organizationId: string, id: string): Promise<Person | null> {
  const [row] = await getDb().query<PersonRow>(`${SELECT_PEOPLE} where p.organization_id = $1 and p.id = $2`, [
    organizationId,
    id,
  ]);
  return row ? toPerson(row) : null;
}

async function findIdByName(organizationId: string, name: string): Promise<string | null> {
  const [row] = await getDb().query<{ id: string }>(
    "select id from people where organization_id = $1 and lower(name) = lower($2)",
    [organizationId, name.trim()],
  );
  return row?.id ?? null;
}

export type PersonInput = {
  name: string;
  role?: string;
  responsibilities?: string;
  email?: string;
  phone?: string;
  /** Exact name of their manager; "" clears it. Unknown managers are added as not-invited people. */
  managerName?: string;
};

/** Adds a person, or updates the fields passed for an existing person with the same name. */
export async function savePerson(organizationId: string, input: PersonInput): Promise<Person> {
  const name = input.name.trim();
  if (!name) throw new Error("A person needs a name.");

  let managerId: string | null = null;
  const managerName = input.managerName?.trim();
  if (managerName && managerName.toLowerCase() !== name.toLowerCase()) {
    managerId =
      (await findIdByName(organizationId, managerName)) ??
      (await savePerson(organizationId, { name: managerName })).id;
  }

  const blankToNull = (value?: string) => (value === undefined ? undefined : value.trim() || null);
  const email = blankToNull(input.email);
  const phone = blankToNull(input.phone);

  const [row] = await getDb().query<{ id: string }>(
    `insert into people (organization_id, name, role, responsibilities, email, phone, manager_id)
     values ($1, $2, coalesce($3, ''), coalesce($4, ''), $5, $6, $8)
     on conflict (organization_id, lower(name)) do update set
       role = coalesce($3, people.role),
       responsibilities = coalesce($4, people.responsibilities),
       email = case when $9 then $5 else people.email end,
       phone = case when $10 then $6 else people.phone end,
       manager_id = case when $7 then $8 else people.manager_id end,
       updated_at = now()
     returning id`,
    [
      organizationId,
      name,
      input.role?.trim() ?? null,
      input.responsibilities?.trim() ?? null,
      email ?? null,
      phone ?? null,
      input.managerName !== undefined,
      managerId,
      email !== undefined,
      phone !== undefined,
    ],
  );
  return (await getPerson(organizationId, row.id))!;
}

export async function removePerson(organizationId: string, id: string): Promise<void> {
  await getDb().query("delete from people where organization_id = $1 and id = $2", [organizationId, id]);
}

/**
 * Renames someone, keeping everything attached to them (tasks, reporting
 * lines, their login). Returns null if no one has the current name.
 */
export async function renamePerson(organizationId: string, currentName: string, newName: string): Promise<Person | null> {
  const id = await findIdByName(organizationId, currentName);
  const name = newName.trim();
  if (!id) return null;
  if (!name) throw new Error("A person needs a name.");
  const clash = await findIdByName(organizationId, name);
  if (clash && clash !== id) throw new Error(`Someone called ${name} is already in the people list.`);
  await getDb().query("update people set name = $3, updated_at = now() where organization_id = $1 and id = $2", [
    organizationId,
    id,
    name,
  ]);
  return getPerson(organizationId, id);
}

/**
 * Removes someone from the org chart, which also takes them off every task.
 * People who have signed in are only removed from the Team page (which also
 * removes their access); this refuses them, and anyone in `protect`.
 */
export async function removePersonByName(
  organizationId: string,
  name: string,
  { protect = [] }: { protect?: string[] } = {},
): Promise<"removed" | "not_found" | "has_account"> {
  const id = await findIdByName(organizationId, name);
  if (!id) return "not_found";
  const person = await getPerson(organizationId, id);
  if (protect.includes(id) || person?.status === "active") return "has_account";
  await removePerson(organizationId, id);
  return "removed";
}

export async function markInvited(
  organizationId: string,
  id: string,
  invitation: { id: string; url: string },
): Promise<void> {
  await getDb().query(
    `update people set status = 'invited', workos_invitation_id = $3, invite_url = $4, updated_at = now()
     where organization_id = $1 and id = $2 and status <> 'active'`,
    [organizationId, id, invitation.id, invitation.url],
  );
}

/**
 * Called whenever a signed-in user opens the app: makes sure they appear in
 * the org chart as an active person, matching an existing entry by email.
 */
export async function linkMember(
  organizationId: string,
  user: { id: string; email: string; name: string },
): Promise<Person> {
  const db = getDb();
  const [linked] = await db.query<{ id: string }>(
    "select id from people where organization_id = $1 and workos_user_id = $2",
    [organizationId, user.id],
  );
  if (linked) return (await getPerson(organizationId, linked.id))!;

  const [byEmail] = await db.query<{ id: string }>(
    "select id from people where organization_id = $1 and lower(email) = lower($2)",
    [organizationId, user.email],
  );
  if (byEmail) {
    await db.query(
      "update people set status = 'active', workos_user_id = $3, invite_url = null, updated_at = now() where id = $2 and organization_id = $1",
      [organizationId, byEmail.id, user.id],
    );
    return (await getPerson(organizationId, byEmail.id))!;
  }

  // New person. Fall back to the email if their name clashes with someone else's.
  const name = (await findIdByName(organizationId, user.name)) ? user.email : user.name;
  const [created] = await db.query<{ id: string }>(
    `insert into people (organization_id, name, email, status, workos_user_id)
     values ($1, $2, $3, 'active', $4) returning id`,
    [organizationId, name, user.email, user.id],
  );
  await syncPeopleSection(organizationId);
  return (await getPerson(organizationId, created.id))!;
}

/** Re-renders the profile's people table and reporting lines from the database. */
export async function syncPeopleSection(organizationId: string): Promise<string> {
  const people = await listPeople(organizationId);
  const section = renderPeople(
    people.map((p) => ({
      name: p.name,
      role: p.role,
      reportsTo: p.managerName ?? "",
      responsibilities: p.responsibilities,
      contact: [p.email, p.phone].filter(Boolean).join(", "),
    })),
  );
  return updateProfile(organizationId, (markdown) => setSection(markdown, PEOPLE_SECTION, section));
}
