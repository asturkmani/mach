"use server";

import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { revalidatePath } from "next/cache";

import { setRole, type Role } from "@/lib/members";
import { getPerson, handOverShared, markInvited, PersonError, removePerson, savePerson, syncPeopleSection, updatePerson, type Person, type PersonPatch } from "@/lib/people";
import { disconnectGitHub } from "@/lib/github";
import { personalSandboxName, sandboxes } from "@/lib/sandbox";
import { requireAppContext } from "@/lib/session";

export type ActionResult = { error?: string; message?: string };

const ok = (message?: string): ActionResult => {
  revalidatePath("/team");
  return { message };
};

function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: string })?.message;
  return message ? `${fallback} ${message}` : fallback;
}

/** Adds someone, and invites them by email straight away when "invite" is ticked (admins only). */
export async function addPersonAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const { organization, user, isAdmin } = await requireAppContext();
  const field = (key: string) => String(form.get(key) ?? "").trim();
  const name = field("name");
  if (!name) return { error: "Enter a name." };
  const email = field("email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That email address doesn't look right." };

  let person: Person;
  try {
    person = await savePerson(organization.id, {
      name,
      // Blank fields leave an existing person's details unchanged.
      role: field("role") || undefined,
      managerName: field("manager") || undefined,
      email: email || undefined,
      phone: field("phone") || undefined,
    });
  } catch (error) {
    return { error: errorMessage(error, "Could not save that person.") };
  }
  await syncPeopleSection(organization.id);
  if (form.get("invite") !== "on" || !isAdmin || person.status === "active") return ok(`Added ${name}.`);
  if (!person.email) return ok(`Added ${name}. Add their email to invite them.`);
  const invited = await sendInvite(organization.id, user.id, person);
  if (invited.error) return { ...ok(), error: `Added ${name}, but the invitation didn't send. ${invited.error}` };
  return ok(`Added ${name} and sent an invitation to ${person.email}.`);
}

/** Edits someone's details on the Team page (anyone on the team can, as they can add people). */
export async function updatePersonAction(personId: string, patch: PersonPatch): Promise<ActionResult> {
  const { organization } = await requireAppContext();
  const allowed: (keyof PersonPatch)[] = ["name", "role", "responsibilities", "email", "phone"];
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => allowed.includes(k as keyof PersonPatch) && typeof v === "string" && v.length <= 2000),
  ) as PersonPatch;
  try {
    await updatePerson(organization.id, personId, clean);
  } catch (error) {
    if (error instanceof PersonError) return { error: error.message };
    throw error;
  }
  await syncPeopleSection(organization.id);
  return ok();
}

export async function setManagerAction(personId: string, managerName: string): Promise<ActionResult> {
  const { organization } = await requireAppContext();
  const person = await getPerson(organization.id, personId);
  if (!person) return { error: "That person no longer exists." };
  await savePerson(organization.id, { name: person.name, managerName });
  await syncPeopleSection(organization.id);
  return ok();
}

export async function inviteAction(personId: string): Promise<ActionResult> {
  const { organization, user, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can invite people." };
  const person = await getPerson(organization.id, personId);
  if (!person) return { error: "That person no longer exists." };
  if (!person.email) return { error: `Add an email address for ${person.name} first.` };
  if (person.status === "active") return { error: `${person.name} has already joined.` };
  const sent = await sendInvite(organization.id, user.id, person);
  return sent.error ? sent : ok(`Invitation sent to ${person.email}.`);
}

/** Sends (or resends) someone's WorkOS invitation to join the company. */
async function sendInvite(organizationId: string, inviterUserId: string, person: Person): Promise<ActionResult> {
  const workos = getWorkOS();
  try {
    const invitation = person.invitationId
      ? await workos.userManagement.resendInvitation(person.invitationId)
      : await workos.userManagement.sendInvitation({
          email: person.email!,
          organizationId,
          inviterUserId,
        });
    await markInvited(organizationId, person.id, { id: invitation.id, url: invitation.acceptInvitationUrl });
  } catch (error) {
    return { error: errorMessage(error, "WorkOS couldn't send the invitation.") };
  }
  return {};
}

export async function removePersonAction(personId: string): Promise<ActionResult> {
  const { organization, person: me, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can remove people." };
  if (personId === me.id) return { error: "You can't remove yourself." };
  const person = await getPerson(organization.id, personId);
  if (!person) return ok();

  const workos = getWorkOS();
  try {
    if (person.status === "invited" && person.invitationId) {
      await workos.userManagement.revokeInvitation(person.invitationId);
    }
    if (person.workosUserId) {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        organizationId: organization.id,
        userId: person.workosUserId,
      });
      for (const membership of memberships.data) {
        await workos.userManagement.deleteOrganizationMembership(membership.id);
      }
    }
  } catch (error) {
    return { error: errorMessage(error, `Couldn't remove ${person.name}'s access in WorkOS.`) };
  }
  // What they shared passes to the admin removing them; their GitHub grant to Mach1 is revoked.
  await handOverShared(organization.id, person.id, me.id);
  await disconnectGitHub(organization.id, person.id).catch((error) => console.error(`Couldn't disconnect ${person.name}'s GitHub`, error));
  // Their own sandbox (their assistant's computer) goes with them.
  await sandboxes()
    .remove(personalSandboxName(person.id))
    .catch((error) => console.error(`Couldn't delete ${person.name}'s sandbox`, error));

  await removePerson(organization.id, person.id);
  await syncPeopleSection(organization.id);
  return ok(`Removed ${person.name}.`);
}

/** Makes someone who has joined an admin, or a member again (admins only, not themselves). */
export async function setRoleAction(personId: string, role: Role): Promise<ActionResult> {
  const { organization, person: me, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change roles." };
  if (personId === me.id) return { error: "Ask another admin to change your role." };
  const person = await getPerson(organization.id, personId);
  if (!person?.workosUserId) return { error: "They need to join before they can be an admin." };
  try {
    await setRole(organization.id, person.workosUserId, role);
  } catch (error) {
    return { error: errorMessage(error, "Couldn't change their role.") };
  }
  return ok(role === "admin" ? `${person.name} is now an admin.` : `${person.name} is now a member.`);
}
