import "server-only";

import { workos } from "@/lib/workos";


import { listAgents, updateAgent, type AgentStatus } from "@/lib/agents/store";
import { attachToTask, listLibrary, setFileVisibility } from "@/lib/files";
import { disconnectGitHub } from "@/lib/github";
import { deleteIntegration, getIntegration, IntegrationError, testIntegration, updateIntegration } from "@/lib/integrations";
import { setRole, type Role } from "@/lib/members";
import { setCompanyModels, type CompanyModels } from "@/lib/orgs";
import { deletePage, getPage, PageError, restorePageVersion, setPageVisibility } from "@/lib/pages";
import {
  getPerson,
  handOverShared,
  listPeople,
  markInvited,
  PersonError,
  removePerson,
  savePerson,
  syncPeopleSection,
  updatePerson,
  type Person,
  type PersonPatch,
} from "@/lib/people";
import { findSource, removeSource, saveSource, updateSource } from "@/lib/research/store";
import { SourceError, sourceLabel, type ResearchSource, type SourceKind } from "@/lib/research/sources";
import { personalSandboxName, sandboxes } from "@/lib/sandbox";
import { addMessage, canSeeTask } from "@/lib/tasks";
import { rerunScript, WorkError } from "@/lib/work";

// What people can do to the company's things, with who may do it, in one
// place: the app's screens and the Chief of Staff (on anyone's behalf, from
// the chat panel, WhatsApp or email) both go through here, so chat can never
// do more than the person could in the app. Each throws OperationError with a
// message for the person when they may not, or when it can't be done.

/** Who's doing it: a member of the company, an admin or not. */
export type Actor = {
  organizationId: string;
  /** Their entry on the Team page. */
  personId: string;
  name: string;
  /** Their WorkOS user, who sends invitations. */
  userId: string;
  isAdmin: boolean;
};

export class OperationError extends Error {}

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

/** Runs an operation, turning the errors the libraries raise for people into OperationErrors. */
async function asOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof PersonError ||
      error instanceof PageError ||
      error instanceof IntegrationError ||
      error instanceof WorkError ||
      error instanceof SourceError
    ) {
      throw new OperationError(error.message);
    }
    throw error;
  }
}

function adminOnly(actor: Actor, what: string): void {
  if (!actor.isAdmin) throw new OperationError(`Only admins can ${what}.`);
}

async function personOf(actor: Actor, personId: string): Promise<Person> {
  const person = await getPerson(actor.organizationId, personId);
  if (!person) throw new OperationError("That person no longer exists.");
  return person;
}

// ---- The team ---------------------------------------------------------------

/** Adds someone (anyone can), and invites them by email straight away if asked (admins). Returns what happened, in words. */
export async function addPersonAs(
  actor: Actor,
  input: { name: string; role?: string; manager?: string; email?: string; phone?: string },
  { invite = false }: { invite?: boolean } = {},
): Promise<{ person: Person; message: string; warning?: string }> {
  const name = input.name.trim();
  if (!name) throw new OperationError("Enter a name.");
  const email = input.email?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OperationError("That email address doesn't look right.");
  const person = await asOperation(() =>
    savePerson(actor.organizationId, {
      name,
      // Blank fields leave an existing person's details unchanged.
      role: input.role?.trim() || undefined,
      managerName: input.manager?.trim() || undefined,
      email: email || undefined,
      phone: input.phone?.trim() || undefined,
    }),
  );
  await syncPeopleSection(actor.organizationId);
  if (!invite || !actor.isAdmin || person.status === "active") return { person, message: `Added ${name}.` };
  if (!person.email) return { person, message: `Added ${name}. Add their email to invite them.` };
  try {
    await sendInvite(actor, person);
  } catch (error) {
    return { person, message: `Added ${name}.`, warning: `Added ${name}, but the invitation didn't send. WorkOS couldn't send the invitation. ${(error as Error).message}` };
  }
  return { person, message: `Added ${name} and sent an invitation to ${person.email}.` };
}

/** Edits someone's details (anyone on the team can, as they can add people). */
export async function updatePersonAs(actor: Actor, personId: string, patch: PersonPatch): Promise<Person> {
  const allowed: (keyof PersonPatch)[] = ["name", "role", "responsibilities", "email", "phone"];
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => allowed.includes(k as keyof PersonPatch) && typeof v === "string" && v.length <= 2000),
  ) as PersonPatch;
  const person = await asOperation(() => updatePerson(actor.organizationId, personId, clean));
  await syncPeopleSection(actor.organizationId);
  return person;
}

export async function setManagerAs(actor: Actor, personId: string, managerName: string): Promise<void> {
  const person = await personOf(actor, personId);
  await asOperation(() => savePerson(actor.organizationId, { name: person.name, managerName }));
  await syncPeopleSection(actor.organizationId);
}

/** Sends (or resends) someone's invitation to join the company (admins). */
export async function invitePersonAs(actor: Actor, personId: string): Promise<string> {
  adminOnly(actor, "invite people");
  const person = await personOf(actor, personId);
  if (!person.email) throw new OperationError(`Add an email address for ${person.name} first.`);
  if (person.status === "active") throw new OperationError(`${person.name} has already joined.`);
  try {
    await sendInvite(actor, person);
  } catch (error) {
    throw new OperationError(`WorkOS couldn't send the invitation: ${(error as Error).message}`);
  }
  return `Invitation sent to ${person.email}.`;
}

async function sendInvite(actor: Actor, person: Person): Promise<void> {
  const client = await workos();
  const invitation = person.invitationId
    ? await client.userManagement.resendInvitation(person.invitationId)
    : await client.userManagement.sendInvitation({ email: person.email!, organizationId: actor.organizationId, inviterUserId: actor.userId });
  await markInvited(actor.organizationId, person.id, { id: invitation.id, url: invitation.acceptInvitationUrl });
}

/**
 * Takes someone off the team (admins, not themselves): their access in
 * WorkOS goes, what they shared passes to the admin removing them, their
 * GitHub grant and their own sandbox go.
 */
export async function removePersonAs(actor: Actor, personId: string): Promise<string> {
  adminOnly(actor, "remove people");
  if (personId === actor.personId) throw new OperationError("You can't remove yourself.");
  const person = await getPerson(actor.organizationId, personId);
  if (!person) return "They're already gone.";
  const client = await workos();
  try {
    if (person.status === "invited" && person.invitationId) await client.userManagement.revokeInvitation(person.invitationId);
    if (person.workosUserId) {
      const memberships = await client.userManagement.listOrganizationMemberships({ organizationId: actor.organizationId, userId: person.workosUserId });
      for (const membership of memberships.data) await client.userManagement.deleteOrganizationMembership(membership.id);
    }
  } catch (error) {
    throw new OperationError(`Couldn't remove ${person.name}'s access in WorkOS: ${(error as Error).message}`);
  }
  await handOverShared(actor.organizationId, person.id, actor.personId);
  await disconnectGitHub(actor.organizationId, person.id).catch((error) => console.error(`Couldn't disconnect ${person.name}'s GitHub`, error));
  await sandboxes()
    .remove(personalSandboxName(person.id))
    .catch((error) => console.error(`Couldn't delete ${person.name}'s sandbox`, error));
  await removePerson(actor.organizationId, person.id);
  await syncPeopleSection(actor.organizationId);
  return `Removed ${person.name}.`;
}

/** Makes someone who has joined an admin, or a member again (admins, not themselves). */
export async function setRoleAs(actor: Actor, personId: string, role: Role): Promise<string> {
  adminOnly(actor, "change roles");
  if (personId === actor.personId) throw new OperationError("Ask another admin to change your role.");
  const person = await personOf(actor, personId);
  if (!person.workosUserId) throw new OperationError("They need to join before they can be an admin.");
  try {
    await setRole(actor.organizationId, person.workosUserId, role);
  } catch (error) {
    throw new OperationError(`Couldn't change their role: ${(error as Error).message}`);
  }
  return role === "admin" ? `${person.name} is now an admin.` : `${person.name} is now a member.`;
}

// ---- Files and pages --------------------------------------------------------

/** Shares a library file with the company, or makes it private again (its owner, or an admin). */
export async function setFileVisibilityAs(actor: Actor, fileId: string, visibility: "company" | "private"): Promise<void> {
  const file = (await listLibrary(actor.organizationId, { limit: 1000, viewer: actor.personId })).find((f) => f.id === fileId);
  if (!file) throw new OperationError("That file doesn't exist.");
  if (file.ownerPersonId !== actor.personId && !actor.isAdmin) throw new OperationError("Only its owner, or an admin, can change who sees it.");
  await setFileVisibility(actor.organizationId, fileId, visibility);
}

/** A library file this person can see (theirs, the company's, or on a task they can see), with its latest version. */
export async function visibleFile(actor: Actor, match: { id?: string; name?: string }) {
  const files = await listLibrary(actor.organizationId, { limit: 1000, viewer: actor.personId });
  const file = files.find((f) => (match.id ? f.id === match.id : f.name.trim().toLowerCase() === match.name?.trim().toLowerCase()));
  if (!file) throw new OperationError(match.name ? `There's no file called ${match.name}.` : "That file doesn't exist.");
  return file;
}

/** Puts a library file on a task as one of its inputs (a task and a file they can both see). */
export async function attachFileAs(actor: Actor, taskId: string, fileId: string): Promise<void> {
  if (!(await canSeeTask(actor.organizationId, taskId, actor.personId))) throw new OperationError("That task doesn't exist.");
  await visibleFile(actor, { id: fileId });
  try {
    await attachToTask(actor.organizationId, taskId, fileId, "input");
  } catch (error) {
    throw new OperationError(error instanceof Error ? error.message : "Couldn't attach that file.");
  }
  await addMessage(taskId, { author: actor.name, personId: actor.personId, kind: "event", body: "Attached a file from the library." });
}

async function pageFor(actor: Actor, slug: string) {
  const page = await getPage(actor.organizationId, slug, { viewer: actor.personId });
  if (!page) throw new OperationError("There's no such page.");
  return page;
}

/** Shares a page (and its refresh job) with the company, or makes it private (whoever made it, or an admin). */
export async function setPageVisibilityAs(actor: Actor, slug: string, visibility: "company" | "private"): Promise<void> {
  const page = await pageFor(actor, slug);
  if (page.createdByPersonId !== actor.personId && !actor.isAdmin) throw new OperationError("Only whoever made it, or an admin, can change who sees it.");
  await asOperation(() => setPageVisibility(actor.organizationId, slug, visibility));
}

/** Runs a page's refresh job now. */
export async function refreshPageAs(actor: Actor, slug: string): Promise<void> {
  const page = await pageFor(actor, slug);
  if (!page.taskId) throw new OperationError("This page has no refresh job yet.");
  await asOperation(() => rerunScript(actor.organizationId, page.taskId!, { name: actor.name, personId: actor.personId }));
}

export async function restorePageAs(actor: Actor, slug: string, version: number): Promise<void> {
  await pageFor(actor, slug);
  await asOperation(() => restorePageVersion(actor.organizationId, slug, version, { name: actor.name, personId: actor.personId }));
}

export async function deletePageAs(actor: Actor, slug: string): Promise<void> {
  await pageFor(actor, slug);
  await asOperation(() => deletePage(actor.organizationId, slug, { name: actor.name, personId: actor.personId }));
}

// ---- Integrations -----------------------------------------------------------

/** Changes an integration: its access, which agents may use it, whose work may (admins), or turns it off. */
export async function updateIntegrationAs(
  actor: Actor,
  id: string,
  patch: { access?: "read" | "write"; agentIds?: string[] | null; personIds?: string[] | null; disabled?: boolean },
): Promise<void> {
  if (patch.personIds !== undefined) adminOnly(actor, "choose whose work may use an integration");
  if (!(await getIntegration(actor.organizationId, id))) throw new OperationError("That integration doesn't exist.");
  let { agentIds, personIds } = patch;
  if (agentIds) {
    const own = new Set((await listAgents(actor.organizationId)).map((a) => a.id));
    agentIds = agentIds.filter((a) => own.has(a));
  }
  if (personIds) {
    const own = new Set((await listPeople(actor.organizationId)).map((p) => p.id));
    personIds = personIds.filter((p) => own.has(p));
  }
  await asOperation(() => updateIntegration(actor.organizationId, id, { ...patch, agentIds, personIds }));
}

export async function testIntegrationAs(actor: Actor, id: string) {
  return asOperation(() => testIntegration(actor.organizationId, id));
}

export async function deleteIntegrationAs(actor: Actor, id: string): Promise<void> {
  await asOperation(() => deleteIntegration(actor.organizationId, id));
}

// ---- Research sources -------------------------------------------------------

/** Saves a source as high signal for them (anyone, for themselves), or shares it for the company's research. Returns what happened, in words. */
export async function saveSourceAs(
  actor: Actor,
  input: { source: string; kind?: SourceKind; note?: string; shareWithCompany?: boolean },
): Promise<string> {
  const { source, created } = await asOperation(() =>
    saveSource(actor.organizationId, {
      source: input.source,
      kind: input.kind,
      note: input.note,
      visibility: input.shareWithCompany === undefined ? undefined : input.shareWithCompany ? "company" : "private",
      ownerPersonId: actor.personId,
    }),
  );
  const whose = source.visibility === "company" ? "for the company's research" : "for your research";
  return `${created ? "Saved" : "Updated"} ${sourceLabel(source)} as a high-signal source ${whose}.`;
}

/** A source they can see, by id or as they'd say it; changing it is for whoever saved it, or an admin for the company's. */
async function sourceToChange(actor: Actor, ref: string): Promise<ResearchSource> {
  const source = await findSource(actor.organizationId, actor.personId, ref);
  if (!source) throw new OperationError(`You have no saved source ${ref}.`);
  if (source.ownerPersonId !== actor.personId && !actor.isAdmin) {
    throw new OperationError(`${sourceLabel(source)} is the company's; only whoever saved it, or an admin, can change it.`);
  }
  return source;
}

export async function updateSourceAs(actor: Actor, ref: string, patch: { note?: string; shareWithCompany?: boolean }): Promise<string> {
  const source = await sourceToChange(actor, ref);
  const visibility = patch.shareWithCompany === undefined ? undefined : patch.shareWithCompany ? "company" : "private";
  await updateSource(actor.organizationId, source.id, { note: patch.note, visibility });
  return visibility === "company"
    ? `${sourceLabel(source)} is shared for the company's research.`
    : visibility === "private"
      ? `${sourceLabel(source)} is just yours now.`
      : `Saved ${sourceLabel(source)}.`;
}

export async function removeSourceAs(actor: Actor, ref: string): Promise<string> {
  const source = await sourceToChange(actor, ref);
  await removeSource(actor.organizationId, source.id);
  return `Removed ${sourceLabel(source)} from the saved sources.`;
}

// ---- Agents and the company -------------------------------------------------

/** Edits an agent: its profile, its model, or pauses, archives or brings it back (anyone on the team). */
export async function updateAgentAs(
  actor: Actor,
  agentId: string,
  patch: { name?: string; role?: string; description?: string; instructions?: string; model?: string; status?: AgentStatus },
): Promise<void> {
  try {
    const agent = await updateAgent(actor.organizationId, agentId, patch);
    if (!agent) throw new OperationError("That agent doesn't exist.");
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError((error as Error).message);
  }
}

/** The company's own default models for the Chief of Staff and agents (admins); empty goes back to Mach1's. */
export async function setCompanyModelsAs(actor: Actor, models: CompanyModels): Promise<void> {
  adminOnly(actor, "choose the company's models");
  for (const id of Object.values(models)) {
    if (id?.trim() && !MODEL_ID.test(id.trim())) throw new OperationError(`${id} isn't a model id. Use provider/model, e.g. anthropic/claude-sonnet-4.5.`);
  }
  await setCompanyModels(actor.organizationId, models);
}
