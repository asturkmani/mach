"use server";

import { getWorkOS, signOut } from "@workos-inc/authkit-nextjs";
import { refresh } from "next/cache";

import { agentmailConfigured, createInbox } from "@/lib/channels/agentmail";
import { phoneDigits } from "@/lib/channels/senders";
import { setEmailInbox } from "@/lib/orgs";
import { setPhone } from "@/lib/people";
import { deleteCompany } from "@/lib/delete-company";
import { requireAppContext } from "@/lib/session";

/**
 * Deletes the company and everything it has in Mach (admins only, after they
 * type its name), then signs them out: their session pointed at it.
 */
export async function deleteCompanyAction(confirmName: string): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only an admin can delete the company." };
  if (confirmName.trim().toLowerCase() !== organization.name.trim().toLowerCase()) {
    return { error: `Type ${organization.name} to confirm.` };
  }
  try {
    await deleteCompany(organization.id, {
      removeFromWorkOS: async (id) => {
        await getWorkOS().organizations.deleteOrganization(id);
      },
    });
  } catch (error) {
    console.error(error);
    return { error: "Couldn't finish deleting the company. Try again: it picks up where it stopped." };
  }
  await signOut();
  return {};
}

/** The signed-in person's WhatsApp number, which lets them message the Chief of Staff. */
export async function savePhoneAction(phone: string): Promise<{ error?: string }> {
  const { organization, person } = await requireAppContext();
  const value = phone.trim();
  if (value && (!value.startsWith("+") || phoneDigits(value).length < 8)) {
    return { error: "Use the full number with its country code, e.g. +44 7700 900123." };
  }
  await setPhone(organization.id, person.id, value);
  refresh();
  return {};
}

/** Gives the company an email address for its Chief of Staff (admins). */
export async function createEmailInboxAction(): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only an admin can set up the company's email address." };
  if (!agentmailConfigured()) return { error: "Email isn't set up for Mach yet (AGENTMAIL_API_KEY)." };
  if (organization.emailInbox) return {};
  try {
    await setEmailInbox(organization.id, await createInbox(organization.name));
  } catch (error) {
    console.error(error);
    return { error: "Couldn't create the email address. Try again." };
  }
  refresh();
  return {};
}
