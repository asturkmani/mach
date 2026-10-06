import "server-only";

import { getWorkOS, withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { cache } from "react";

import { createOrganization, getOrganization, type Organization } from "@/lib/orgs";
import { linkMember, type Person } from "@/lib/people";

export type SessionUser = { id: string; email: string; name: string };

export type AppContext = {
  user: SessionUser;
  organization: Organization;
  person: Person;
  isAdmin: boolean;
};

export function displayName(user: { email: string; firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email.split("@")[0];
}

/**
 * The signed-in user and their current organization, or `organization: null`
 * if they haven't created or joined one yet. Redirects to sign-in when signed out.
 * Cached per request, so layouts and pages can both call it.
 */
export const getSessionContext = cache(async function getSessionContext(): Promise<
  { user: SessionUser; organization: null } | AppContext
> {
  const auth = await withAuth({ ensureSignedIn: true });
  const user: SessionUser = { id: auth.user.id, email: auth.user.email, name: displayName(auth.user) };
  if (!auth.organizationId) return { user, organization: null };

  let organization = await getOrganization(auth.organizationId);
  if (!organization) {
    // Org exists in WorkOS but not here yet (e.g. created in the WorkOS dashboard).
    const workosOrg = await getWorkOS().organizations.getOrganization(auth.organizationId);
    await createOrganization({ id: workosOrg.id, name: workosOrg.name });
    organization = (await getOrganization(auth.organizationId))!;
  }

  const person = await linkMember(organization.id, user);
  return { user, organization, person, isAdmin: auth.role === "admin" };
});

/** For pages that need an organization: sends people without one to /welcome. */
export async function requireAppContext(): Promise<AppContext> {
  const context = await getSessionContext();
  if (!context.organization) redirect("/welcome");
  return context;
}
