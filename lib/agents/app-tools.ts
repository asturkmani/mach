import "server-only";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { findAgentByName, listAgents } from "@/lib/agents/store";
import { appUrl } from "@/lib/app-url";
import { listLibrary } from "@/lib/files";
import { getIntegration } from "@/lib/integrations";
import { sendWhatsAppFile } from "@/lib/channels/twilio";
import { fileLinkToken } from "@/lib/file-links";
import {
  attachFileAs,
  deletePageAs,
  deleteIntegrationAs,
  invitePersonAs,
  OperationError,
  refreshPageAs,
  removePersonAs,
  restorePageAs,
  setCompanyModelsAs,
  setFileVisibilityAs,
  setRoleAs,
  testIntegrationAs,
  updateAgentAs,
  updateIntegrationAs,
  visibleFile,
  type Actor,
} from "@/lib/operations";
import { listPeople } from "@/lib/people";
import { getTaskByNumber, PRIORITIES, removeMember, TASK_STATUSES, updateTask } from "@/lib/tasks";
import { addMessage } from "@/lib/tasks";
import {
  addToTask,
  archiveTask,
  pauseTaskSchedule,
  rerunScript,
  runNow,
  scheduleTask,
  setStatus,
  unarchiveTask,
  unscheduleTask,
  WorkError,
} from "@/lib/work";

// What people do on the app's screens, from chat: the Chief of Staff does it
// as the person it's talking to, through the same code (and the same rules:
// lib/operations.ts, and only tasks they can see) as the screens, so it can
// never do more than they could in the app.

/** Runs a change, turning a refusal into words for the model. */
async function attempt(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OperationError || error instanceof WorkError) return `Not done: ${error.message}`;
    throw error;
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function appTools(actor: Actor | null, { whatsapp }: { whatsapp?: string | null } = {}): ToolSet {
  if (!actor) return {};
  const orgId = actor.organizationId;
  const by = { name: actor.name, personId: actor.personId };

  async function personNamed(name: string) {
    const person = (await listPeople(orgId)).find((p) => same(p.name, name));
    if (!person) throw new OperationError(`No one called ${name} is on the Team page.`);
    return person;
  }
  async function agentNamed(name: string) {
    const agent = await findAgentByName(orgId, name);
    if (!agent) throw new OperationError(`There's no agent called ${name}.`);
    return agent;
  }
  async function taskNumbered(number: number) {
    const task = await getTaskByNumber(orgId, number, { viewer: actor!.personId });
    if (!task) throw new OperationError(`There's no task #${number}.`);
    return task;
  }

  return {
    team_access: tool({
      description:
        "Invite someone on the Team page to Mach1 by email (or send their invitation again), make someone who has joined an admin or a member again, or take someone off the team (their access, their own sandbox and GitHub grant go; what they shared passes to you). Admins only; nobody changes their own role or removes themselves. Add or edit people's details with save_person.",
      inputSchema: z.object({
        person: z.string().describe("Their exact name on the Team page."),
        action: z.enum(["invite", "make_admin", "make_member", "remove"]),
      }),
      execute: ({ person, action }) =>
        attempt(async () => {
          const found = await personNamed(person);
          if (action === "invite") return invitePersonAs(actor, found.id);
          if (action === "remove") return removePersonAs(actor, found.id);
          return setRoleAs(actor, found.id, action === "make_admin" ? "admin" : "member");
        }),
    }),

    update_task: tool({
      description:
        "Change a task the way its screen does: status, priority, later, title or description, archive or bring back, who's on it, run one of its agents now, its schedule (repeat, pause, resume, stop) or re-run its script. Only the fields you pass change. For a message to its agent, use reply_on_task.",
      inputSchema: z.object({
        number: z.number().int().positive(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        later_until: z.string().optional().describe("Hide it from Needs you until this ISO 8601 time; empty brings it back now."),
        title: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        archive: z.boolean().optional().describe("true archives it (its sandbox goes), false brings it back."),
        add: z.array(z.string()).optional().describe("Exact names of people or agents to put on it."),
        remove: z.array(z.string()).optional().describe("Exact names of people or agents to take off it."),
        run_agent: z.string().optional().describe("Exact name of an agent on it to run now."),
        repeat: z
          .object({ cron: z.string(), timezone: z.string(), mode: z.enum(["script", "agent"]) })
          .optional()
          .describe("Set or change its schedule: five-field cron in the timezone."),
        schedule: z.enum(["pause", "resume", "stop"]).optional(),
        rerun_script: z.boolean().optional().describe("Run its run.sh again now (jobs with a script)."),
      }),
      execute: (input) =>
        attempt(async () => {
          const task = await taskNumbered(input.number);
          const done: string[] = [];
          if (input.archive === true) {
            await archiveTask(orgId, task.id, by);
            done.push("archived");
          }
          if (input.archive === false) {
            await unarchiveTask(orgId, task.id, by);
            done.push("brought back");
          }
          if (input.title || input.description !== undefined) {
            await updateTask(orgId, task.id, { ...(input.title ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}) });
            done.push("text updated");
          }
          if (input.status) {
            await setStatus(orgId, task.id, input.status, by);
            done.push(`status ${input.status}`);
          }
          if (input.priority) {
            await updateTask(orgId, task.id, { priority: input.priority });
            done.push(`priority ${input.priority}`);
          }
          if (input.later_until !== undefined) {
            const until = input.later_until ? new Date(input.later_until) : null;
            if (until && Number.isNaN(until.getTime())) throw new OperationError(`${input.later_until} isn't a time I can read.`);
            await updateTask(orgId, task.id, { laterUntil: until });
            done.push(until ? `later until ${until.toISOString()}` : "back from later");
          }
          for (const name of input.add ?? []) {
            const person = (await listPeople(orgId)).find((p) => same(p.name, name));
            const agent = person ? null : await findAgentByName(orgId, name);
            if (!person && !agent) throw new OperationError(`No person or agent called ${name}.`);
            await addToTask(orgId, task.id, by, person ? { personId: person.id } : { agentId: agent!.id });
            done.push(`added ${name}`);
          }
          for (const name of input.remove ?? []) {
            const member = task.members.find((m) => same(m.name, name));
            if (!member) throw new OperationError(`${name} isn't on #${task.number}.`);
            await removeMember(task.id, member.type === "person" ? { personId: member.id } : { agentId: member.id });
            await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: `Took ${member.name} off this task.` });
            done.push(`took ${name} off`);
          }
          if (input.repeat) {
            await scheduleTask(orgId, task.id, by, input.repeat);
            done.push("schedule set");
          }
          if (input.schedule === "stop") {
            await unscheduleTask(orgId, task.id, by);
            done.push("stopped repeating");
          } else if (input.schedule) {
            await pauseTaskSchedule(orgId, task.id, by, input.schedule === "pause");
            done.push(input.schedule === "pause" ? "schedule paused" : "schedule resumed");
          }
          if (input.rerun_script) {
            await rerunScript(orgId, task.id, by);
            done.push("script re-run started");
          }
          if (input.run_agent) {
            const agent = await agentNamed(input.run_agent);
            await runNow(orgId, task.id, agent.id, by);
            done.push(`${agent.name} started`);
          }
          return done.length ? `#${task.number}: ${done.join(", ")}. ${appUrl(`/tasks/${task.number}`)}` : "Nothing to change.";
        }),
    }),

    update_agent: tool({
      description:
        "Change one of the company's agents as its page does: name, role, job description, instructions, the model it runs on (an AI Gateway id like anthropic/claude-sonnet-4.5; empty goes back to the default), or pause, archive or bring it back.",
      inputSchema: z.object({
        agent: z.string().describe("Its exact name."),
        name: z.string().optional(),
        role: z.string().optional(),
        description: z.string().optional(),
        instructions: z.string().optional().describe("Replaces its instructions: keep what should stay."),
        model: z.string().optional(),
        status: z.enum(["active", "paused", "archived"]).optional(),
      }),
      execute: ({ agent, ...patch }) =>
        attempt(async () => {
          const found = await agentNamed(agent);
          await updateAgentAs(actor, found.id, patch);
          return `Saved ${patch.name ?? found.name}. ${appUrl(`/agents/${found.id}`)}`;
        }),
    }),

    share_file: tool({
      description: "Share a library file with the whole company, or make it private again (its owner, or an admin).",
      inputSchema: z.object({ file: z.string().describe("Its exact name in Files."), withCompany: z.boolean() }),
      execute: ({ file, withCompany }) =>
        attempt(async () => {
          const found = (await listLibrary(orgId, { limit: 1000, viewer: actor.personId })).find((f) => same(f.name, file));
          if (!found) throw new OperationError(`There's no file called ${file}.`);
          await setFileVisibilityAs(actor, found.id, withCompany ? "company" : "private");
          return withCompany ? `${found.name} is shared with the company.` : `${found.name} is private.`;
        }),
    }),

    attach_file: tool({
      description: "Put one of the company's files (from Files, or one they just sent you) on a task as an input, so its agent works from it.",
      inputSchema: z.object({ number: z.number().int().positive(), file: z.string().describe("Its exact name in Files.") }),
      execute: ({ number, file }) =>
        attempt(async () => {
          const task = await taskNumbered(number);
          const found = await visibleFile(actor, { name: file });
          await attachFileAs(actor, task.id, found.id);
          return `Attached ${found.name} to #${task.number}.`;
        }),
    }),

    send_file: tool({
      description: whatsapp
        ? "Send one of the company's files to the person you're talking to, here on WhatsApp (its latest version), with an optional caption. Use it when they ask for a file, a report or a model."
        : "Get a download link to one of the company's files (its latest version) to give the person you're talking to.",
      inputSchema: z.object({ file: z.string().describe("Its exact name in Files."), caption: z.string().optional() }),
      execute: ({ file, caption }) =>
        attempt(async () => {
          const found = await visibleFile(actor, { name: file });
          const latest = found.versions[0];
          if (!latest) throw new OperationError(`${found.name} has no saved version yet.`);
          if (!whatsapp) return `Download link: ${appUrl(`/files/${latest.id}`)}`;
          await sendWhatsAppFile(`+${whatsapp}`, appUrl(`/api/files/${fileLinkToken(orgId, latest.id)}`), caption);
          return `Sent ${found.name} on WhatsApp.`;
        }),
    }),

    manage_page: tool({
      description: "Refresh a page's data now, go back to an earlier version of it, or delete it. To share it, use share_page.",
      inputSchema: z.object({
        page: z.string().describe("Its slug, e.g. net-worth."),
        action: z.enum(["refresh", "restore", "delete"]),
        version: z.number().int().positive().optional().describe("With restore: the version to go back to."),
      }),
      execute: ({ page, action, version }) =>
        attempt(async () => {
          if (action === "refresh") {
            await refreshPageAs(actor, page);
            return "Refreshing now.";
          }
          if (action === "restore") {
            if (!version) throw new OperationError("Say which version to go back to.");
            await restorePageAs(actor, page, version);
            return `Back to version ${version}. ${appUrl(`/pages/${page}`)}`;
          }
          await deletePageAs(actor, page);
          return "Deleted.";
        }),
    }),

    update_integration: tool({
      description:
        "Change one of the company's integrations: which agents may use it, whose work may (admins), read-only or read and write, turn it off or on, test it, or delete it. Credentials are never set here: send them to Settings → Integrations.",
      inputSchema: z.object({
        integration: z.string().describe("Its slug."),
        agents: z.array(z.string()).optional().describe('Exact agent names, or ["all"] for every agent.'),
        people: z.array(z.string()).optional().describe('Exact names of the people whose work may use it, or ["all"].'),
        access: z.enum(["read", "write"]).optional(),
        enabled: z.boolean().optional(),
        test: z.boolean().optional(),
        delete: z.boolean().optional(),
      }),
      execute: (input) =>
        attempt(async () => {
          const found = await getIntegration(orgId, input.integration);
          if (!found) throw new OperationError(`There's no integration called ${input.integration}.`);
          if (input.delete) {
            await deleteIntegrationAs(actor, found.id);
            return `Deleted ${found.name}.`;
          }
          const all = (names?: string[]) => names?.length === 1 && same(names[0], "all");
          let agentIds: string[] | null | undefined;
          if (input.agents) {
            const agents = await listAgents(orgId);
            agentIds = all(input.agents)
              ? null
              : input.agents.map((name) => {
                  const agent = agents.find((a) => same(a.name, name));
                  if (!agent) throw new OperationError(`There's no agent called ${name}.`);
                  return agent.id;
                });
          }
          let personIds: string[] | null | undefined;
          if (input.people) {
            personIds = all(input.people) ? null : await Promise.all(input.people.map(async (name) => (await personNamed(name)).id));
          }
          if (agentIds !== undefined || personIds !== undefined || input.access || input.enabled !== undefined) {
            await updateIntegrationAs(actor, found.id, {
              ...(agentIds !== undefined ? { agentIds } : {}),
              ...(personIds !== undefined ? { personIds } : {}),
              ...(input.access ? { access: input.access } : {}),
              ...(input.enabled !== undefined ? { disabled: !input.enabled } : {}),
            });
          }
          if (input.test) {
            const tested = await testIntegrationAs(actor, found.id);
            return `Saved. Test: ${tested.status.replace("_", " ")}${tested.statusDetail ? ` (${tested.statusDetail})` : ""}.`;
          }
          return `Saved ${found.name}.`;
        }),
    }),

    set_company_models: tool({
      description:
        "Choose the company's own default models (AI Gateway ids such as anthropic/claude-sonnet-4.5): for you, the Chief of Staff, and for agents. Empty goes back to Mach1's. Admins only. AI provider keys are never set here: send them to Settings → AI.",
      inputSchema: z.object({ chiefOfStaff: z.string().optional(), agents: z.string().optional() }),
      execute: (models) =>
        attempt(async () => {
          await setCompanyModelsAs(actor, models);
          return `Saved. ${appUrl("/settings/ai")}`;
        }),
    }),
  };
}
