"use server";

import { getWorkOS, switchToOrganization } from "@workos-inc/authkit-nextjs";

import { createOrganization } from "@/lib/orgs";
import { pendingInvitation } from "@/lib/sign-in";
import { linkMember, syncPeopleSection } from "@/lib/people";
import { getSessionContext } from "@/lib/session";
import { normalizeWebsite } from "@/lib/website";

export type CreateCompanyState = { error?: string };

export async function createCompany(_: CreateCompanyState, form: FormData): Promise<CreateCompanyState> {
  const name = String(form.get("name") ?? "").trim();
  const websiteInput = String(form.get("website") ?? "").trim();
  if (!name) return { error: "Enter your company's name." };

  const website = websiteInput ? normalizeWebsite(websiteInput) : null;
  if (websiteInput && !website) return { error: "That website doesn't look like a valid address." };

  const { user } = await getSessionContext();

  const workos = getWorkOS();

  // The creator becomes the organization's admin in WorkOS.
  const org = await workos.organizations.createOrganization({ name });
  try {
    await workos.userManagement.createOrganizationMembership({
      organizationId: org.id,
      userId: user.id,
      roleSlug: "admin",
    });
  } catch (error) {
    await workos.organizations.deleteOrganization(org.id).catch(() => undefined);
    console.error("Could not add the creator to the new organization", error);
    return { error: "Could not set up your company in WorkOS. Check that an 'admin' role exists, then try again." };
  }

  await createOrganization({ id: org.id, name, website });
  await linkMember(org.id, user);
  await syncPeopleSection(org.id);

  // Puts the new organization into the session cookie, then redirects home.
  await switchToOrganization(org.id, { returnTo: "/" });
  return {};
}

/** For people who already belong to a company (e.g. accepted an invite) but whose session has none selected. */
export async function openCompany(form: FormData): Promise<void> {
  const organizationId = String(form.get("organizationId") ?? "");
  const { user } = await getSessionContext();
  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
    userId: user.id,
    organizationId,
    statuses: ["active"],
  });
  if (memberships.data.length === 0) throw new Error("You're not a member of that company.");
  await switchToOrganization(organizationId, { returnTo: "/" });
}

/** Accepts the invitation waiting for this person's email (one that reached them without its link's token). */
export async function acceptInvitationAction(): Promise<void> {
  const { user } = await getSessionContext();
  const invitation = await pendingInvitation(user.email);
  if (!invitation) throw new Error("That invitation is no longer open. Ask for a new one.");
  await getWorkOS().userManagement.acceptInvitation(invitation.id);
  await switchToOrganization(invitation.organizationId, { returnTo: "/" });
}
