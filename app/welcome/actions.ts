"use server";

import { getWorkOS, switchToOrganization } from "@workos-inc/authkit-nextjs";
import { revalidatePath } from "next/cache";

import { createOrganization, findOrganizationByDomain } from "@/lib/orgs";
import { addToCompany, requestToJoin } from "@/lib/members";
import { linkMember, syncPeopleSection } from "@/lib/people";
import { getCompanyDomain, getSessionContext } from "@/lib/session";
import { normalizeWebsite } from "@/lib/website";

export type CreateCompanyState = { error?: string };

export async function createCompany(_: CreateCompanyState, form: FormData): Promise<CreateCompanyState> {
  const name = String(form.get("name") ?? "").trim();
  const websiteInput = String(form.get("website") ?? "").trim();
  if (!name) return { error: "Enter your company's name." };

  const website = websiteInput ? normalizeWebsite(websiteInput) : null;
  if (websiteInput && !website) return { error: "That website doesn't look like a valid address." };

  const { user } = await getSessionContext();

  // One company per work email domain: colleagues join the existing one by invitation.
  const domain = await getCompanyDomain();
  if (domain) {
    const existing = await findOrganizationByDomain(domain);
    if (existing) return { error: `${existing.name} already uses Mach for @${domain} emails. Ask to join it instead.` };
  }

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

  await createOrganization({ id: org.id, name, website, domain });
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

/** The company that owns the signed-in person's verified work email domain, if there is one. */
async function domainCompany() {
  const domain = await getCompanyDomain();
  return domain ? findOrganizationByDomain(domain) : null;
}

/** A colleague asks the company's admins to let them in. */
export async function requestToJoinAction(): Promise<void> {
  const { user } = await getSessionContext();
  const company = await domainCompany();
  if (!company) throw new Error("No company on Mach uses your email domain.");
  await requestToJoin(company, { userId: user.id, email: user.email, name: user.name });
  revalidatePath("/welcome");
}

/** Joins straight away, when the company's admins let colleagues join on their own. */
export async function joinCompanyAction(): Promise<void> {
  const { user } = await getSessionContext();
  const company = await domainCompany();
  if (!company?.autoJoin) throw new Error("Ask to join instead: this company's admins let people in.");
  await addToCompany(company.id, user);
  await switchToOrganization(company.id, { returnTo: "/" });
}
