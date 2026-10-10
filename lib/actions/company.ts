import "server-only";

import { z } from "zod";

import { agentFor, agentRef, defineAction, fileFor, fileRef, integrationFor, personFor, personRef } from "@/lib/actions/define";
import { MEMORY_LIMIT, savePersonalMemory } from "@/lib/agents/conversation";
import { listAgents } from "@/lib/agents/store";
import { appUrl } from "@/lib/app-url";
import { saveAssistantHours } from "@/lib/assistant/store";
import { agentmailConfigured, createInbox, ensureEmailWebhook } from "@/lib/channels/agentmail";
import { sendWhatsAppFile } from "@/lib/channels/twilio";
import { fileLinkToken } from "@/lib/file-links";
import { disconnectGitHub } from "@/lib/github";
import { forgetSession } from "@/lib/integrations";
import {
  addPersonAs,
  deleteIntegrationAs,
  deletePageAs,
  invitePersonAs,
  OperationError,
  refreshPageAs,
  removePersonAs,
  restorePageAs,
  setCompanyModelsAs,
  setFileVisibilityAs,
  setManagerAs,
  setPageVisibilityAs,
  setRoleAs,
  testIntegrationAs,
  updateAgentAs,
  updateIntegrationAs,
  updatePersonAs,
} from "@/lib/operations";
import { getOrganization, setEmailInbox } from "@/lib/orgs";

// What the Team, agent, Files, Pages, Integrations and Settings screens do.
// Who may do what lives in lib/operations.ts.

const all = (names?: string[]) => names?.length === 1 && names[0].trim().toLowerCase() === "all";

export const companyActions = [
  // ---- The team
  defineAction({
    name: "person.add",
    description: "Add someone to the Team page, and invite them to Mach1 by email straight away if asked (admins).",
    input: z.object({
      name: z.string().min(1),
      role: z.string().optional(),
      manager: z.string().optional().describe("Exact name of who they report to."),
      email: z.string().optional(),
      phone: z.string().optional(),
      invite: z.boolean().optional(),
    }),
    run: async ({ actor }, { invite, ...input }) => {
      const added = await addPersonAs(actor, input, { invite });
      return added.warning ?? added.message;
    },
  }),
  defineAction({
    name: "person.update",
    description: "Change someone's details on the Team page: name, role, responsibilities, email or phone.",
    input: z.object({
      person: personRef,
      name: z.string().optional(),
      role: z.string().optional(),
      responsibilities: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    }),
    run: async ({ actor }, { person, ...patch }) => {
      const found = await personFor(actor, person);
      const saved = await updatePersonAs(actor, found.id, patch);
      return `Saved ${saved.name}.`;
    },
  }),
  defineAction({
    name: "person.set_manager",
    description: "Set who someone reports to (empty for no one).",
    input: z.object({ person: personRef, manager: z.string() }),
    run: async ({ actor }, { person, manager }) => {
      const found = await personFor(actor, person);
      await setManagerAs(actor, found.id, manager);
      return manager ? `${found.name} reports to ${manager}.` : `${found.name} reports to no one.`;
    },
  }),
  defineAction({
    name: "person.invite",
    description: "Invite someone on the Team page to Mach1 by email, or send their invitation again.",
    input: z.object({ person: personRef }),
    who: "admin",
    run: async ({ actor }, { person }) => invitePersonAs(actor, (await personFor(actor, person)).id),
  }),
  defineAction({
    name: "person.set_role",
    description: "Make someone who has joined an admin, or a member again.",
    input: z.object({ person: personRef, role: z.enum(["admin", "member"]) }),
    who: "admin",
    run: async ({ actor }, { person, role }) => setRoleAs(actor, (await personFor(actor, person)).id, role),
  }),
  defineAction({
    name: "person.remove",
    description: "Take someone off the team: their access, their own sandbox and GitHub grant go; what they shared passes to you.",
    input: z.object({ person: personRef }),
    who: "admin",
    run: async ({ actor }, { person }) => removePersonAs(actor, (await personFor(actor, person)).id),
  }),

  // ---- Agents
  defineAction({
    name: "agent.update",
    description: "Change an agent: name, role, job description, instructions (replaces them), or the model it runs on (an AI Gateway id; empty for the default).",
    input: z.object({
      agent: agentRef,
      name: z.string().optional(),
      role: z.string().optional(),
      description: z.string().optional(),
      instructions: z.string().optional(),
      model: z.string().optional(),
    }),
    run: async ({ actor }, { agent, ...patch }) => {
      const found = await agentFor(actor, agent);
      if (patch.name !== undefined && !patch.name.trim()) throw new OperationError("Give the agent a name.");
      await updateAgentAs(actor, found.id, patch);
      return `Saved ${patch.name ?? found.name}. ${appUrl(`/agents/${found.id}`)}`;
    },
  }),
  defineAction({
    name: "agent.set_status",
    description: "Pause an agent, archive it, or bring it back (active).",
    input: z.object({ agent: agentRef, status: z.enum(["active", "paused", "archived"]) }),
    run: async ({ actor }, { agent, status }) => {
      const found = await agentFor(actor, agent);
      await updateAgentAs(actor, found.id, { status });
      return `${found.name} is ${status}.`;
    },
  }),

  // ---- Files and pages
  defineAction({
    name: "file.set_visibility",
    description: "Share a file with the whole company, or make it private again (its owner, or an admin).",
    input: z.object({ file: fileRef, visibility: z.enum(["company", "private"]) }),
    run: async ({ actor }, { file, visibility }) => {
      const found = await fileFor(actor, file);
      await setFileVisibilityAs(actor, found.id, visibility);
      return visibility === "company" ? `${found.name} is shared with the company.` : `${found.name} is private.`;
    },
  }),
  defineAction({
    name: "file.send",
    description: "Send a file (its latest version) to the person you're talking to: on WhatsApp when that's where you're talking, else a download link to give them.",
    input: z.object({ file: fileRef, caption: z.string().optional() }),
    run: async ({ actor, whatsapp }, { file, caption }) => {
      const found = await fileFor(actor, file);
      const latest = found.versions[0];
      if (!latest) throw new OperationError(`${found.name} has no saved version yet.`);
      if (!whatsapp) return `Download link: ${appUrl(`/files/${latest.id}`)}`;
      await sendWhatsAppFile(`+${whatsapp}`, appUrl(`/api/files/${fileLinkToken(actor.organizationId, latest.id)}`), caption);
      return `Sent ${found.name} on WhatsApp.`;
    },
  }),
  defineAction({
    name: "page.set_visibility",
    description: "Share a page (and its refresh job) with the company, or make it private (whoever made it, or an admin).",
    input: z.object({ page: z.string().describe("Its slug."), visibility: z.enum(["company", "private"]) }),
    run: async ({ actor }, { page, visibility }) => {
      await setPageVisibilityAs(actor, page, visibility);
      return visibility === "company" ? "Shared with the company." : "Private.";
    },
  }),
  defineAction({
    name: "page.refresh",
    description: "Refresh a page's data now (runs its refresh job).",
    input: z.object({ page: z.string().describe("Its slug.") }),
    run: async ({ actor }, { page }) => {
      await refreshPageAs(actor, page);
      return "Refreshing now.";
    },
  }),
  defineAction({
    name: "page.restore",
    description: "Put a page back to an earlier version.",
    input: z.object({ page: z.string().describe("Its slug."), version: z.number().int().positive() }),
    run: async ({ actor }, { page, version }) => {
      await restorePageAs(actor, page, version);
      return `Back to version ${version}. ${appUrl(`/pages/${page}`)}`;
    },
  }),
  defineAction({
    name: "page.delete",
    description: "Delete a page.",
    input: z.object({ page: z.string().describe("Its slug.") }),
    run: async ({ actor }, { page }) => {
      await deletePageAs(actor, page);
      return "Deleted.";
    },
  }),

  // ---- Integrations (credentials are never set here: Settings → Integrations)
  defineAction({
    name: "integration.update",
    description: 'Change an integration: which agents may use it (names, or ["all"]), whose work may (people, or ["all"]; admins), read or write access, or turn it off or on.',
    input: z.object({
      integration: z.string().describe("Its slug (or id)."),
      agents: z.array(z.string()).optional(),
      people: z.array(z.string()).optional(),
      access: z.enum(["read", "write"]).optional(),
      enabled: z.boolean().optional(),
    }),
    run: async ({ actor }, { integration, agents, people, access, enabled }) => {
      const found = await integrationFor(actor, integration);
      let agentIds: string[] | null | undefined;
      if (agents) {
        const own = await listAgents(actor.organizationId);
        agentIds = all(agents)
          ? null
          : agents.map((name) => {
              const agent = own.find((a) => a.id === name || a.name.trim().toLowerCase() === name.trim().toLowerCase());
              if (!agent) throw new OperationError(`There's no agent called ${name}.`);
              return agent.id;
            });
      }
      const personIds = people ? (all(people) ? null : await Promise.all(people.map(async (name) => (await personFor(actor, name)).id))) : undefined;
      await updateIntegrationAs(actor, found.id, {
        ...(agentIds !== undefined ? { agentIds } : {}),
        ...(personIds !== undefined ? { personIds } : {}),
        ...(access ? { access } : {}),
        ...(enabled !== undefined ? { disabled: !enabled } : {}),
      });
      return `Saved ${found.name}.`;
    },
  }),
  defineAction({
    name: "integration.test",
    description: "Test an integration's connection.",
    input: z.object({ integration: z.string() }),
    run: async ({ actor }, { integration }) => {
      const found = await integrationFor(actor, integration);
      const tested = await testIntegrationAs(actor, found.id);
      return `${found.name}: ${tested.status.replace("_", " ")}${tested.statusDetail ? ` (${tested.statusDetail})` : ""}.`;
    },
  }),
  defineAction({
    name: "integration.forget_session",
    description: "Forget a website login's saved session, so the next agent signs in afresh.",
    input: z.object({ integration: z.string() }),
    run: async ({ actor }, { integration }) => {
      const found = await integrationFor(actor, integration);
      await forgetSession(actor.organizationId, found.id);
      return `Forgot ${found.name}'s session.`;
    },
  }),
  defineAction({
    name: "integration.delete",
    description: "Delete an integration.",
    input: z.object({ integration: z.string() }),
    run: async ({ actor }, { integration }) => {
      const found = await integrationFor(actor, integration);
      await deleteIntegrationAs(actor, found.id);
      return `Deleted ${found.name}.`;
    },
  }),

  // ---- Settings
  defineAction({
    name: "company.set_models",
    description: "Choose the company's own default models (AI Gateway ids) for the Chief of Staff and for agents; empty goes back to Mach1's.",
    input: z.object({ chiefOfStaff: z.string().optional(), agents: z.string().optional() }),
    who: "admin",
    run: async ({ actor }, models) => {
      await setCompanyModelsAs(actor, models);
      return `Saved. ${appUrl("/settings/ai")}`;
    },
  }),
  defineAction({
    name: "company.set_up_email",
    description: "Give the company an email address for its Chief of Staff, so people can email you (once).",
    input: z.object({}),
    who: "admin",
    run: async ({ actor }) => {
      const organization = await getOrganization(actor.organizationId);
      if (organization?.emailInbox) return `The company's address is ${organization.emailInbox}.`;
      if (!agentmailConfigured()) throw new OperationError("Email isn't set up for Mach1 yet (AGENTMAIL_API_KEY).");
      let inbox: string;
      try {
        inbox = await createInbox(organization?.name ?? "company");
        await setEmailInbox(actor.organizationId, inbox);
        await ensureEmailWebhook();
      } catch (error) {
        console.error(error);
        throw new OperationError("Couldn't create the email address. Try again.");
      }
      return `The company's address is ${inbox}.`;
    },
  }),
  defineAction({
    name: "me.set_hours",
    description: "Save your timezone, working days and hours, and quiet hours.",
    input: z.object({
      timezone: z.string().describe("IANA, e.g. Asia/Dubai."),
      days: z.array(z.number().int().min(1).max(7)).describe("ISO weekdays: 1 Monday … 6 Saturday, 7 Sunday (never 0). Sunday to Thursday is [7, 1, 2, 3, 4]."),
      start: z.string().describe("HH:MM, e.g. 08:00."),
      end: z.string().describe("HH:MM, e.g. 17:00."),
      quietStart: z.string().describe("No messages from, HH:MM, e.g. 22:00."),
      quietEnd: z.string().describe("Until, HH:MM, e.g. 07:00."),
    }),
    run: async ({ actor }, { timezone, ...hours }) => {
      try {
        await saveAssistantHours(actor.organizationId, actor.personId, timezone.trim(), hours);
      } catch (error) {
        throw new OperationError((error as Error).message);
      }
      return "Saved your hours.";
    },
  }),
  defineAction({
    name: "me.set_notes",
    description: "Rewrite what your assistant knows about you.",
    input: z.object({ notes: z.string() }),
    run: async ({ actor }, { notes }) => {
      if (notes.length > MEMORY_LIMIT) throw new OperationError(`Keep it under ${MEMORY_LIMIT} characters.`);
      await savePersonalMemory(actor.organizationId, actor.personId, notes);
      return "Saved.";
    },
  }),
  defineAction({
    name: "me.disconnect_github",
    description: "Disconnect your GitHub from Mach1 (and revoke what you granted it).",
    input: z.object({}),
    run: async ({ actor }) => {
      await disconnectGitHub(actor.organizationId, actor.personId);
      return "Disconnected your GitHub.";
    },
  }),
];
