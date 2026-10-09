import "server-only";

import { getWorkOS } from "@workos-inc/authkit-nextjs";

import { getDb } from "@/lib/db";
import type { Organization } from "@/lib/orgs";
import { linkMember, listPeople, syncPeopleSection } from "@/lib/people";
import { pushToPeople } from "@/lib/push";
import { addMessage, countInbox, createTask, getTask, updateTask, type Task } from "@/lib/tasks";

// Who belongs to a company and as what. Memberships and roles live in WorkOS
// ("admin" or "member"); whoever creates a company is its first admin, and
// admins can make others admins. Colleagues signing up with the company's work
// email domain either join straight away (when an admin turned on auto-join)
// or ask, which puts a request in every admin's inbox.

export type Role = "admin" | "member";

/** Each member's WorkOS membership and role, by WorkOS user id. */
export async function memberRoles(organizationId: string): Promise<Map<string, { membershipId: string; role: Role }>> {
  const roles = new Map<string, { membershipId: string; role: Role }>();
  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({ organizationId, statuses: ["active"], limit: 100 });
  for (const m of memberships.data) roles.set(m.userId, { membershipId: m.id, role: m.role?.slug === "admin" ? "admin" : "member" });
  return roles;
}

/** The people (in Mach) who are the company's admins. */
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
  await getWorkOS().userManagement.updateOrganizationMembership(membership.membershipId, { roleSlug: role });
}

/** Adds someone to the company as a member (in WorkOS and on the Team page). */
export async function addToCompany(organizationId: string, user: { id: string; email: string; name: string }): Promise<void> {
  const existing = await getWorkOS().userManagement.listOrganizationMemberships({ organizationId, userId: user.id });
  if (existing.data.length === 0) {
    await getWorkOS().userManagement.createOrganizationMembership({ organizationId, userId: user.id, roleSlug: "member" });
  } else if (existing.data[0].status !== "active") {
    await getWorkOS().userManagement.reactivateOrganizationMembership(existing.data[0].id);
  }
  await linkMember(organizationId, user);
  await syncPeopleSection(organizationId);
}

// ---- Asking to join ---------------------------------------------------------

type RequestPayload = { userId: string; email: string; name: string };

export type JoinRequest = { taskId: string; status: "pending" | "approved" | "declined"; at: Date };

/** This person's latest request to join this company, if they made one. */
export async function joinRequestFor(organizationId: string, userId: string): Promise<JoinRequest | null> {
  const [row] = await getDb().query<{ id: string; status: string; updated_at: Date }>(
    `select id, status, updated_at from tasks
     where organization_id = $1 and kind = 'join_request' and payload->>'userId' = $2
     order by created_at desc limit 1`,
    [organizationId, userId],
  );
  if (!row) return null;
  const status = row.status === "done" ? "approved" : row.status === "cancelled" ? "declined" : "pending";
  return { taskId: row.id, status, at: row.updated_at };
}

/** Asks the company's admins to let this person in: a request in their inbox, and a notification. */
export async function requestToJoin(organization: Organization, user: RequestPayload): Promise<JoinRequest> {
  const existing = await joinRequestFor(organization.id, user.userId);
  if (existing?.status === "pending") return existing;

  const admins = await adminPersonIds(organization.id);
  const task = await createTask(organization.id, {
    kind: "join_request",
    title: `${user.name} wants to join`,
    description: `${user.name} (${user.email}) signed in with an @${organization.domain} email and asked to join ${organization.name}. Let them in as a member, or decline. You can make them an admin later on the Team page.`,
    summary: `${user.email} asked to join ${organization.name}.`,
    status: "waiting",
    priority: "high",
    options: [{ label: "Let them in", recommended: true }, { label: "Decline" }],
    payload: user,
    people: admins,
  });
  await pushToPeople(
    organization.id,
    admins,
    { title: `${user.name} wants to join ${organization.name}`, body: user.email, url: `/tasks/${task.number}`, tag: `task-${task.id}` },
    { badge: (personId) => countInbox(organization.id, personId) },
  );
  return { taskId: task.id, status: "pending", at: task.createdAt };
}

/** An admin's answer to a request to join. */
export async function decideJoinRequest(
  organizationId: string,
  taskId: string,
  approve: boolean,
  by: { name: string; personId: string },
): Promise<Task> {
  const task = await getTask(organizationId, taskId);
  if (!task || task.kind !== "join_request") throw new Error("That request no longer exists.");
  if (task.status === "done" || task.status === "cancelled") return task;
  const request = task.payload as RequestPayload;
  if (approve) await addToCompany(organizationId, { id: request.userId, email: request.email, name: request.name });
  await updateTask(organizationId, taskId, { status: approve ? "done" : "cancelled", options: [] });
  await addMessage(taskId, {
    author: by.name,
    personId: by.personId,
    kind: "event",
    body: approve ? `Let ${request.name} in.` : `Declined ${request.name}'s request.`,
  });
  return (await getTask(organizationId, taskId))!;
}
