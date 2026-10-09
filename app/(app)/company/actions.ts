"use server";

import { getWorkOS, signOut } from "@workos-inc/authkit-nextjs";
import { refresh } from "next/cache";

import { agentmailConfigured, createInbox, ensureEmailWebhook } from "@/lib/channels/agentmail";
import { whatsappNumber } from "@/lib/channels/twilio";
import { startWhatsAppLink, unlinkWhatsApp } from "@/lib/channels/whatsapp-links";
import { setEmailInbox } from "@/lib/orgs";
import { deleteCompany } from "@/lib/delete-company";
import { requireAppContext } from "@/lib/session";

/**
 * Deletes the company and everything it has in Mach1 (admins only, after they
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

/** A one-time code the signed-in person sends from their WhatsApp to link that number (see whatsapp-links.ts). */
export async function startWhatsAppLinkAction(): Promise<{ code: string; expiresAt: string } | { error: string }> {
  const { organization, person } = await requireAppContext();
  if (!whatsappNumber()) return { error: "WhatsApp isn't set up for Mach1 yet." };
  const { code, expiresAt } = await startWhatsAppLink(organization.id, person.id);
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function unlinkWhatsAppAction(): Promise<void> {
  const { organization, person } = await requireAppContext();
  await unlinkWhatsApp(organization.id, person.id);
  refresh();
}

/** Gives the company an email address for its Chief of Staff (admins). */
export async function createEmailInboxAction(): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only an admin can set up the company's email address." };
  if (!agentmailConfigured()) return { error: "Email isn't set up for Mach1 yet (AGENTMAIL_API_KEY)." };
  if (organization.emailInbox) return {};
  try {
    await setEmailInbox(organization.id, await createInbox(organization.name));
    await ensureEmailWebhook();
  } catch (error) {
    console.error(error);
    return { error: "Couldn't create the email address. Try again." };
  }
  refresh();
  return {};
}
