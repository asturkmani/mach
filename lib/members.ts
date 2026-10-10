import "server-only";


import { getDb } from "@/lib/db";
import { workos } from "@/lib/workos";
import type { Organization } from "@/lib/orgs";
import { linkMember, listPeople, syncPeopleSection } from "@/lib/people";
import { pushToPeople } from "@/lib/push";
import { addMessage, countInbox, createTask, getTask, updateTask, type Task } from "@/lib/tasks";

// Who belongs to a company and as what. Memberships and roles live in WorkOS
// ("admin" or "member"); whoever creates a company is its first admin, and
// admins can make others admins. People join a company only when an admin
// adds and invites them (Team page): never by their email's domain.

export type Role = "admin" | "member";

/** Each member's WorkOS membership and role, by WorkOS user id. */
export async function memberRoles(organizationId: string): Promise<Map<string, { membershipId: string; role: Role }>> {
  const roles = new Map<string, { membershipId: string; role: Role }>();
  const memberships = await (await workos()).userManagement.listOrganizationMemberships({ organizationId, statuses: ["active"], limit: 100 });
  for (const m of memberships.data) roles.set(m.userId, { membershipId: m.id, role: m.role?.slug === "admin" ? "admin" : "member" });
  return roles;
}

/** The people (in Mach1) who are the company's admins. */
export async function adminPersonIds(organizationId: string): Promise<string[]> {
  const [roles, people] = await Promise.all([memberRoles(organizationId), listPeople(organizationId)]);
  return people.filter((p) => p.workosUserId && roles.get(p.workosUserId)?.role === "admin").map((p) => p.id);
}

/** Makes someone an admin, or a member again. */
export async function setRole(organizationId: string, workosUserId: string, role: Role): Promise<void> {
  const membership = (await memberRoles(organizationId)).get(workosUserId);
  if (!membership) throw new Error("They're not a member of this company.");
  if (membership.role === role) return;
  if (role === "member") {
    const admins = [...(await memberRoles(organizationId)).values()].filter((m) => m.role === "admin");
    if (admins.length <= 1) throw new Error("A company needs at least one admin.");
  }
  await (await workos()).userManagement.updateOrganizationMembership(membership.membershipId, { roleSlug: role });
}
