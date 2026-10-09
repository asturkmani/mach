import "server-only";

import { randomInt } from "node:crypto";

import { phoneDigits } from "@/lib/channels/senders";
import { getDb } from "@/lib/db";

// Linking a WhatsApp number to a person, by proof: Mach1 shows them a
// one-time code and they send "LINK <code>" from their WhatsApp to Mach1's
// number. WhatsApp vouches for the number a message comes from, so only
// whoever holds the phone can link it. A number belongs to one person (the
// same person may use it in several companies); linking it moves it away from
// anyone else who had it.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const LIFETIME_MINUTES = 10;

/** "LINK K7P2-9QXM", however it's spaced or cased. */
export const LINK_MESSAGE = /^\s*link\s+([a-z0-9]{4})\s*-?\s*([a-z0-9]{4})\s*$/i;

/** A fresh code for this person (any earlier one stops working). */
export async function startWhatsAppLink(organizationId: string, personId: string): Promise<{ code: string; expiresAt: Date }> {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  await getDb().query("delete from whatsapp_links where person_id = $1 or expires_at < now()", [personId]);
  const [row] = await getDb().query<{ expires_at: Date }>(
    `insert into whatsapp_links (code, organization_id, person_id, expires_at)
     values ($1, $2, $3, now() + interval '${LIFETIME_MINUTES} minutes') returning expires_at`,
    [code, organizationId, personId],
  );
  return { code, expiresAt: new Date(row.expires_at) };
}

export type LinkResult = { linked: true; personName: string; companyName: string } | { linked: false };

/** A LINK message from `from`: links that number to whoever the code was made for, if it's still valid. */
export async function completeWhatsAppLink(text: string, from: string): Promise<LinkResult> {
  const match = text.match(LINK_MESSAGE);
  const digits = phoneDigits(from);
  if (!match || digits.length < 8) return { linked: false };
  const code = `${match[1]}-${match[2]}`.toUpperCase();
  const [link] = await getDb().query<{ person_id: string; organization_id: string; workos_user_id: string | null; name: string; company: string }>(
    `delete from whatsapp_links l using people p, organizations o
     where l.code = $1 and l.expires_at > now() and p.id = l.person_id and o.id = l.organization_id
     returning l.person_id, l.organization_id, p.workos_user_id, p.name, o.name as company`,
    [code],
  );
  if (!link?.workos_user_id) return { linked: false };
  // The number now belongs to this person: anyone else (another person, in any company) loses it.
  await getDb().query(
    `update people set whatsapp = null, whatsapp_linked_at = null, updated_at = now()
     where whatsapp = $1 and workos_user_id is distinct from $2`,
    [digits, link.workos_user_id],
  );
  // Their linked WhatsApp is their phone number everywhere (Team page, profile): one number, not two.
  await getDb().query(
    "update people set whatsapp = $2, phone = '+' || $2, whatsapp_linked_at = now(), updated_at = now() where id = $1",
    [link.person_id, digits],
  );
  return { linked: true, personName: link.name, companyName: link.company };
}

export async function unlinkWhatsApp(organizationId: string, personId: string): Promise<void> {
  await getDb().query(
    "update people set whatsapp = null, whatsapp_linked_at = null, updated_at = now() where organization_id = $1 and id = $2",
    [organizationId, personId],
  );
  await getDb().query("delete from whatsapp_links where person_id = $1", [personId]);
}
