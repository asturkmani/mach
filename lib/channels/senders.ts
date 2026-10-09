import "server-only";

import type { ChiefOfStaffContext } from "@/lib/agents/cos-turn";
import { getDb } from "@/lib/db";
import { getOrganization, type Organization } from "@/lib/orgs";
import { getPerson } from "@/lib/people";

// Who a WhatsApp message or an email is from. Only people who have joined
// their company in Mach1 (signed in, so they have a conversation with the Chief
// of Staff) are answered.

/** A phone number as digits with its country code: "+44 7700 900123", "whatsapp:+447700900123" and "0044…" all match. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^00/, "");
}

/** The address in "Ahmed Turk <ahmed@cedar.example>" or a bare address, lowercased. */
export function emailAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

async function contextFor(organizationId: string, personId: string): Promise<ChiefOfStaffContext | null> {
  const [organization, person] = await Promise.all([getOrganization(organizationId), getPerson(organizationId, personId)]);
  if (!organization || !person?.workosUserId) return null;
  return { organization, person, user: { id: person.workosUserId, email: person.email ?? "", name: person.name } };
}

/**
 * The person (and company) a WhatsApp number belongs to. Someone in more than
 * one company reaches the one they talked to the Chief of Staff in last.
 */
export async function findByPhone(phone: string): Promise<ChiefOfStaffContext | null> {
  const digits = phoneDigits(phone);
  if (digits.length < 8) return null;
  const [row] = await getDb().query<{ organization_id: string; id: string }>(
    `select p.organization_id, p.id from people p
     left join chats c on c.organization_id = p.organization_id and c.user_id = p.workos_user_id
     where p.status = 'active' and p.workos_user_id is not null and p.phone is not null
       and regexp_replace(regexp_replace(p.phone, '[^0-9]', '', 'g'), '^00', '') = $1
     order by c.updated_at desc nulls last, p.created_at desc limit 1`,
    [digits],
  );
  return row ? contextFor(row.organization_id, row.id) : null;
}

/** The person in this company an email address belongs to. */
export async function findByEmail(organization: Organization, from: string): Promise<ChiefOfStaffContext | null> {
  const [row] = await getDb().query<{ id: string }>(
    `select id from people where organization_id = $1 and status = 'active' and workos_user_id is not null and lower(email) = $2`,
    [organization.id, emailAddress(from)],
  );
  return row ? contextFor(organization.id, row.id) : null;
}

/** True the first time a provider's message id is seen, so retries aren't answered twice. */
export async function firstTime(provider: string, externalId: string): Promise<boolean> {
  const rows = await getDb().query(
    "insert into inbound_messages (provider, external_id) values ($1, $2) on conflict do nothing returning external_id",
    [provider, externalId],
  );
  return rows.length > 0;
}
