import "server-only";

import {
  ToolLoopAgent,
  tool,
  type InferAgentUIMessage,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";

import { pageTools } from "@/lib/agents/page-tools";
import type { AgentContext } from "@/lib/agents/prompts";
import { appUrl } from "@/lib/app-url";
import { skillList } from "@/lib/agents/skills";
import {
  browserTools,
  integrationTools,
  researchTools,
  sandboxTools,
  sandboxUser,
  skillTool,
  type SandboxSession,
} from "@/lib/agents/toolkit";
import { createAgent, type Agent } from "@/lib/agents/store";
import { findFiles, type LibraryFile } from "@/lib/files";
import {
  IntegrationError,
  saveIntegration,
  type ApiConfig,
  type Integration,
  type LoginConfig,
} from "@/lib/integrations";
import { completeOnboarding, renameOrganization, type Organization } from "@/lib/orgs";
import type { Page } from "@/lib/pages";
import { removePersonByName, renamePerson, savePerson, syncPeopleSection, type Person } from "@/lib/people";
import {
  isCaptured,
  onboardingChecklist,
  PEOPLE_SECTION,
  SECTIONS,
  setCompanyName,
  setSection,
} from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import { describeSchedule } from "@/lib/schedules";
import type { SessionUser } from "@/lib/session";
import { PRIORITIES, type Task } from "@/lib/tasks";
import { createTaskWithTeam, resolveTeam, suggestProfileUpdate, WorkError } from "@/lib/work";

/** Where a message to the Chief of Staff came from, besides the app's chat panel. */
export type Channel = "whatsapp" | "email";

type Context = {
  organization: Organization;
  user: SessionUser;
  profile: string;
  /** The signed-in person, who is put on any task they ask for. */
  person?: Person;
  agents?: Agent[];
  openTasks?: Task[];
  /** Recent files in the company library, which new jobs can start from. */
  files?: LibraryFile[];
  /** The company's data sources and logins. */
  integrations?: Integration[];
  /** The company's pages: reports on its data. */
  pages?: Page[];
  /** What they're looking at in the app as they write, e.g. 'the "Net worth" page (…)'. */
  viewing?: string | null;
  /** Set when this turn's message came by WhatsApp or email rather than the app. */
  channel?: Channel;
};

function channelInstructions(channel: Channel): string {
  const where = channel === "whatsapp" ? "WhatsApp" : "email";
  return `This message came by ${where}, and your reply goes back the same way, as plain text. Keep it short: a few sentences or a short list, no tables or headings${
    channel === "whatsapp" ? ", *single asterisks* for bold" : ""
  }. Cards don't show there: when a tool shows one (credentials for an integration, a sign-in code, a profile suggestion to apply), say so and give this link to finish in the app: ${appUrl("/")}. Links to a task are ${appUrl("/tasks/")} followed by its number. It's the same conversation as their chat panel in Mach1, so they can carry on in either.`;
}

function onboardingInstructions({ organization }: Context): string {
  const website = organization.website
    ? `Their website is ${organization.website}. Before your first question, read it with fetch_page (and one or two linked pages such as About or Services if useful), save a draft Overview and anything else it clearly states, then ask them to confirm.`
    : "No website was given. Ask for it once; if they don't have one, ask what the company does and for whom.";

  return `Right now you are onboarding them. The goal is a quick, basic picture of the company in about five minutes, not a complete profile. Everything else gets filled in over time.

Only three things are needed to finish onboarding:
1. What the company does and for whom (Overview). ${website}
2. The team and who reports to whom. Ask for everyone in one go ("Who's on the team? Give me names, roles and who each reports to."). Mention they can also add people on the Team page and invite them from there. If it's just them, that's a complete answer: save their own role and pass justMe to complete_onboarding. Don't push for a team that doesn't exist.
3. The top one to three priorities right now (Goals).

How to run it:
- Ask one question per message and no more than about five questions in total. Keep messages short.
- Propose instead of asking: draft from what you already know and ask "Is that right?".
- Never ask the person to explain a product, tool, company or term you can look up. Use web_search, record what you learn (Glossary or How We Work), and carry on. Example: if they say they use Masttro, look it up and note what it is; don't ask what it is for.
- Don't ask about mission, values, customers, products or glossary unless they bring it up. Record anything they volunteer.
- As soon as the three essentials are captured, call complete_onboarding on its own (after your other saves). If it reports something missing, ask about that in one short question and try again later. Once it succeeds, reply with a three-line summary and tell them they can keep telling you things at any time.`;
}

function afterOnboardingInstructions({ profile }: Context): string {
  const empty = SECTIONS.filter((section) => section !== PEOPLE_SECTION && !isCaptured(profile, section));
  return `Onboarding is complete. You are now the company's Chief of Staff: answer questions using the profile, keep the people list and reporting lines up to date, and turn requests into tasks.

Keeping the profile current:
- Listen for anything new about the company in every message: a tool they use, a customer, a goal that changed, a term you didn't know. When you learn something the profile lacks or gets wrong, call suggest_profile_update straight away (load the company-profile skill first if you haven't), then carry on with what they asked. Don't ask permission; they apply or dismiss it from a card.
- ${empty.length > 0 ? `Still empty in the profile: ${empty.join(", ")}. When the conversation touches these, suggest an update.` : "Every section has something in it; keep them accurate."}
- Don't start an interview. Ask at most one short question when something important is missing.`;
}

function workInstructions(context: Context): string {
  const { agents = [], openTasks = [], files = [], integrations = [], pages = [] } = context;
  const pageLines = pages
    .filter((p) => p.version > 0)
    .map((p) => `- ${p.slug}: ${p.title}, reads ${p.data.join(", ") || "no files"}${p.taskNumber ? `, refreshed by #${p.taskNumber}` : ", not refreshed on a schedule"}`);
  const integrationLines = integrations.map(
    (i) =>
      `- ${i.slug}: ${i.name} (${i.kind === "api" ? "data source" : "login"}, ${i.access === "read" ? "read-only" : "read and write"}, ${i.status.replace("_", " ")}${
        i.agentIds ? `, ${i.agentIds.length} agent${i.agentIds.length === 1 ? "" : "s"} only` : ", every agent"
      })${i.description ? `: ${i.description}` : ""}`,
  );
  const agentLines = agents
    .filter((a) => a.kind === "defined" && a.status === "active")
    .map((a) => `- ${a.name}${a.role ? ` (${a.role})` : ""}${a.description ? `: ${a.description}` : ""}`);
  const taskLines = openTasks
    .slice(0, 30)
    .map((t) => `- #${t.number} ${t.title} [${t.status}] · ${t.members.map((m) => m.name).join(", ") || "no one"}`);
  const fileLines = files
    .filter((f) => f.kind === "deliverable" && f.versions.length)
    .slice(0, 30)
    .map((f) => {
      const v = f.versions[0];
      return `- ${f.name} (v${v.version}${v.taskNumber ? `, from #${v.taskNumber}` : ""})`;
    });
  return `Tasks and agents:
- When someone asks for work to be done ("do a review of…", "draft…", "find…"), create a task with create_task instead of doing the work in chat. Load the writing-tasks skill first. Put an agent on it: a defined agent whose role fits, or a worker agent with a clear role for a one-off job. The agent starts straight away and reports back to their inbox; tell them that in one line.
- Answer quick questions yourself. Create a task only for real work.
- If the same kind of work will keep coming up and no agent fits, offer to create a defined agent with create_agent (load the designing-agents skill first).
- For work that should happen regularly ("every weekday at 4pm chart the option flow", "each Monday summarise…"), pass repeat on create_task. It runs once now and then on the schedule, every run landing on the same task, in the same sandbox, so tell them that. Use the timezone they mention, else the company's (${context.organization.timezone ?? "not known yet: ask"}). Use mode script when code can do the job (data pulls, charts, models: the agent builds run.sh once and later runs replay it cheaply), agent when each run needs judgment. To change an existing job's schedule, tell them to reply on its task or use the Repeats panel there.
- Jobs share a company data drive: datasets one job saves there are available to every other job.

Defined agents:
${agentLines.join("\n") || "(none yet)"}

Open tasks:
${taskLines.join("\n") || "(none)"}

Integrations: the company's other systems, connected so agents can use them without seeing credentials. When someone wants a system connected ("connect Masttro, here are the API docs"), load the connecting-integrations skill and set it up yourself, in this chat: read the docs (with your browser if they need a sign-in), then connect_data_source; they enter credentials in the cards the tools show, never in the chat. Never create an agent or a task to set up an integration. Answer quick questions from a connected data source with call_api. For a website with no API, or changes its API can't make (data entry in Masttro, say), connect a login with connect_login for the agents who'll do that work (a defined agent for that recurring work); they sign in with the browser in their sandbox, and sign-in codes come to the people on the job.

Your sandbox: like every agent, you have a Linux sandbox for the company with a browser in it. Use browse to read pages fetch_page can't (JavaScript apps, pages behind one of the company's logins), and run_code to work through what you saved (an API spec, say). For anything interactive on a website (checking something inside a signed-in app, testing a login, a quick change people asked for), hand it to the browser agent with use_browser: it sees the page, signs in with the company's logins and reports back with screenshots. It's for quick things while you set things up or answer a question; real work still goes to a task.
${integrationLines.join("\n") || "(none yet)"}

Pages: views of the company's data that people keep coming back to (a dashboard of net worth by entity, cash across banks), in Pages and kept up to date. When someone asks for a dashboard, a view, a page or to "see X every morning", load the building-pages skill and build it yourself in this chat: data into files on the drive with a script, the page with save_page, and refresh_page to keep it fresh. Not for one-off answers.
${pageLines.join("\n") || "(no pages yet)"}

Company files (newest first). When a request builds on one ("add a 70/30 case to the portfolio model"), pass it in create_task's files so the job starts from it and saves its next version; if the job that made it is still open, prefer replying there instead of creating a new task:
${fileLines.join("\n") || "(none yet)"}`;
}

export function chiefOfStaffInstructions(context: Context): string {
  const { organization, user, profile } = context;
  const today = new Date().toISOString().slice(0, 10);
  return `You are the Chief of Staff of ${organization.name}, a company that uses Mach1, a command center where people and AI agents run the business together.

You are talking to ${context.person?.name ?? user.name} (${user.email}), who is already in the people list under that name. If you learn their role or manager, save it.

${organization.onboardingCompletedAt ? afterOnboardingInstructions(context) : onboardingInstructions(context)}

${workInstructions(context)}
${context.channel ? `\n${channelInstructions(context.channel)}\n` : ""}${
    context.viewing
      ? `\nRight now they're looking at ${context.viewing} in Mach1, with this chat open beside it. When they say "this", "here" or "it" without saying what, they mean that.\n`
      : ""
  }
Recording facts:
- The company profile below is a markdown document and your memory of the company. Record facts as soon as you learn them; don't ask permission to save.
- Write in the company's own words, concise and factual. Never invent facts.
- Use save_person / remove_person for people. To change someone's name (including the person you're talking to), call save_person with their current name and newName; never remove someone and add them again, which would take them off their tasks. Never write the "${PEOPLE_SECTION}" section with update_section; it is generated from the people list.
${
    organization.onboardingCompletedAt
      ? "- Use suggest_profile_update for every other section, passing the complete new body (markdown, no \"## \" heading). It replaces what was there when applied, so keep anything that should stay."
      : "- Use update_section for every other section, passing the complete new body (markdown, no \"## \" heading). It replaces what was there, so keep anything that should stay.\n- Use set_company_name only if they correct the company's name."
  }

Skills you can load with use_skill:
${skillList()}

Sections: ${SECTIONS.join(", ")}.

Today's date: ${today}.

<company_profile>
${profile}
</company_profile>`;
}

const sectionNames = SECTIONS.filter((s) => s !== PEOPLE_SECTION) as [string, ...string[]];

// Tools return the latest profile for the live preview, but the model only sees
// a short confirmation: it gets the current profile in its instructions on every
// request, so repeating it in each tool result would just bloat the context.
const confirm = (value: string) => () => ({ type: "text" as const, value });

function profileTools(context: Context) {
  const orgId = context.organization.id;
  return {
    set_company_name: tool({
      description: "Correct the company's name.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        await renameOrganization(orgId, name);
        return { profile: await updateProfile(orgId, (md) => setCompanyName(md, name)) };
      },
      toModelOutput: confirm("Saved."),
    }),
    update_section: tool({
      description:
        "Replace the body of one profile section with new markdown. Pass the full section body, not a diff. Not for the people section.",
      inputSchema: z.object({
        section: z.enum(sectionNames),
        content: z.string().describe("Full markdown body for the section, without the '## ' heading."),
      }),
      execute: async ({ section, content }) => ({
        profile: await updateProfile(orgId, (md) => setSection(md, section, content)),
      }),
      toModelOutput: confirm("Saved."),
    }),
    save_person: tool({
      description:
        "Add a person to the organisation or update their details. Only the fields you pass are changed. reportsTo is the exact name of their manager (an unknown manager is added too); use an empty string for someone who reports to no one. To rename someone, pass their current name as name and the new one as newName.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Full name, used as the person's identifier (their current name when renaming)."),
        newName: z.string().optional().describe("Their new name, when renaming them."),
        role: z.string().optional().describe("Job title or role."),
        reportsTo: z.string().optional().describe("Exact name of the person they report to, or empty."),
        responsibilities: z.string().optional().describe("What they own, in a short phrase."),
        email: z.string().optional(),
        phone: z.string().optional().describe("Phone or WhatsApp number."),
      }),
      execute: async ({ reportsTo, newName, ...person }) => {
        let name = person.name;
        if (newName?.trim() && newName.trim().toLowerCase() !== name.trim().toLowerCase()) {
          try {
            const renamed = await renamePerson(orgId, name, newName);
            if (!renamed) return { error: `No one called ${name} is in the people list.`, profile: await syncPeopleSection(orgId) };
            name = renamed.name;
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Couldn't rename them.", profile: await syncPeopleSection(orgId) };
          }
        }
        await savePerson(orgId, { ...person, name, managerName: reportsTo });
        return { profile: await syncPeopleSection(orgId) };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: "error" in output && output.error ? `Not saved: ${output.error}` : "Saved.",
      }),
    }),
    remove_person: tool({
      description:
        "Remove a person from the organisation, which also takes them off every task. Not for renaming (use save_person with newName), and not for anyone who has signed in to Mach1: an admin removes those on the Team page.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const result = await removePersonByName(orgId, name, { protect: context.person ? [context.person.id] : [] });
        return { removed: result === "removed", result, profile: await syncPeopleSection(orgId) };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          output.result === "removed"
            ? "Removed."
            : output.result === "has_account"
              ? "Not removed: they have a Mach1 account (or it's the person you're talking to). To rename someone use save_person with newName; to remove an account, an admin uses the Team page."
              : "No one by that name was in the people list.",
      }),
    }),
    complete_onboarding: tool({
      description:
        "Mark onboarding as finished. Only succeeds once the company overview, the team with reporting lines (everyone but the person at the top has a manager) and top priorities are captured; otherwise it lists what's missing. A one-person company counts: set justMe once they've said nobody else works there.",
      inputSchema: z.object({
        justMe: z
          .boolean()
          .optional()
          .describe("True only when the person you're talking to has said they're the only person in the company."),
      }),
      execute: async ({ justMe }) => {
        // Queued behind any profile updates still in flight from this step.
        const profile = await updateProfile(orgId, (md) => md);
        const missing = onboardingChecklist(profile, { justMe })
          .filter((item) => !item.done)
          .map((item) => (item.detail ? `${item.label} (${item.detail})` : item.label));
        if (missing.length > 0) return { onboardingComplete: false, missing, profile };
        await completeOnboarding(orgId);
        return { onboardingComplete: true, missing, profile };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: output.onboardingComplete
          ? "Onboarding is marked complete. Now reply to them: a three-line summary of what you captured, then one line saying they can tell you anything new at any time or ask you to get work done."
          : `Not complete yet. Missing: ${output.missing.join("; ")}. If you saved this in the same step, call complete_onboarding again. Otherwise ask one short question about it; if someone has no manager, ask where they fit (for example whether the person you're talking to is one of the people already listed); if only one person is listed, ask whether it's just them, and if so call complete_onboarding with justMe.`,
      }),
    }),
  };
}

function workTools(context: Context) {
  const orgId = context.organization.id;
  const by = { name: context.user.name, personId: context.person?.id };
  return {
    create_task: tool({
      description:
        "Create a task for real work and put people and agents on it. The person you're talking to is added automatically. Agents on it start straight away.",
      inputSchema: z.object({
        title: z.string().min(1).max(100).describe("The outcome, starting with a verb."),
        description: z.string().describe("Goal, inputs or sources, what done looks like, and any deadline."),
        priority: z.enum(PRIORITIES).optional(),
        people: z.array(z.string()).optional().describe("Exact names of other people to put on it."),
        agents: z.array(z.string()).optional().describe("Exact names of defined agents to put on it."),
        workerRole: z
          .string()
          .optional()
          .describe("Add a new worker agent with this role, e.g. 'Financial analysis', when no defined agent fits."),
        files: z.array(z.string()).optional().describe("Exact names of company files the job should start from."),
        repeat: z
          .object({
            cron: z.string().describe("Five-field cron in the timezone, e.g. '0 16 * * 1-5' for weekdays at 16:00."),
            timezone: z.string().describe("IANA timezone, e.g. Europe/London."),
            mode: z.enum(["script", "agent"]).describe("script: replay the job's run.sh each time. agent: the agent does the job each time."),
          })
          .optional()
          .describe("Makes it a recurring job. The first run starts now."),
      }),
      execute: async ({ title, description, priority, people, agents, workerRole, files, repeat }) => {
        try {
          const found = await findFiles(orgId, files ?? []);
          const missing = (files ?? []).filter((name) => !found.some((f) => f.name.toLowerCase() === name.trim().toLowerCase()));
          if (missing.length) throw new WorkError(`No company file called ${missing.join(", ")}.`);
          const team = await resolveTeam(orgId, { people, agents });
          const task = await createTaskWithTeam(orgId, {
            title,
            description,
            priority,
            personIds: team.people.map((p) => p.id),
            agentIds: team.agents.map((a) => a.id),
            workerRole,
            inputFileIds: found.map((f) => f.id),
            schedule: repeat,
            by,
          });
          return {
            task: { id: task.id, number: task.number, title: task.title },
            members: task.members.map((m) => m.name),
            repeats: repeat ? describeSchedule(repeat.cron, repeat.timezone) : null,
          };
        } catch (error) {
          if (error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not created: ${output.error}`
            : `Created task #${output.task.number} with ${output.members.join(", ")}.${output.repeats ? ` Repeats: ${output.repeats}.` : ""}`,
      }),
    }),
    connect_data_source: tool({
      description:
        "Connect (or reconfigure) an HTTP API as a company data source agents can call without seeing its credentials. Shows the person a secure card to enter the credentials, which then tests the connection. Never put credentials in this call.",
      inputSchema: z.object({
        name: z.string().min(1).max(60).describe("The system's name, e.g. Masttro."),
        slug: z.string().optional().describe("Short handle agents use, e.g. masttro. Defaults from the name; reuse it to reconfigure."),
        description: z.string().describe("What data it holds and what it's for, in a sentence or two."),
        baseUrl: z.string().describe("e.g. https://api.masttro.com/v1"),
        domains: z.array(z.string()).optional().describe("Other hosts requests may go to (the base URL's host is included)."),
        fields: z
          .array(
            z.object({
              name: z.string().describe("e.g. apiKey, clientId, clientSecret"),
              label: z.string().describe("What the person sees, e.g. API key"),
              secret: z.boolean().optional(),
              optional: z.boolean().optional(),
            }),
          )
          .describe("The credentials the person enters."),
        headers: z.record(z.string(), z.string()).optional().describe('Templates, e.g. { "Authorization": "Bearer {{apiKey}}" }.'),
        query: z.record(z.string(), z.string()).optional().describe('Query parameter templates, e.g. { "api_key": "{{apiKey}}" }.'),
        token: z
          .object({
            url: z.string(),
            method: z.enum(["POST", "GET"]).optional(),
            format: z.enum(["json", "form"]).optional(),
            body: z.record(z.string(), z.string()).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            path: z.string().describe("Where the token is in the JSON response, e.g. access_token."),
            expiresInPath: z.string().optional(),
            ttlSeconds: z.number().optional(),
          })
          .optional()
          .describe("When the API swaps credentials for a short-lived token first; then sign requests with {{token}}."),
        testPath: z.string().optional().describe("A cheap GET that succeeds when the credentials work."),
        docsUrl: z.string().optional(),
        access: z.enum(["read", "write"]).optional().describe("read (the default): agents can only GET."),
        agents: z.array(z.string()).optional().describe("Exact names of the only agents allowed; leave out for every agent."),
        guide: z.string().optional().describe("Markdown for agents: main endpoints and parameters, paging, limits, field meanings."),
      }),
      execute: async ({ agents: agentNames, ...input }) => {
        try {
          const team = agentNames ? await resolveTeam(orgId, { agents: agentNames }) : null;
          const config: ApiConfig = {
            baseUrl: input.baseUrl,
            domains: input.domains ?? [],
            fields: input.fields,
            headers: input.headers,
            query: input.query,
            token: input.token,
            testPath: input.testPath,
            docsUrl: input.docsUrl,
          };
          const integration = await saveIntegration(orgId, {
            kind: "api",
            name: input.name,
            slug: input.slug,
            description: input.description,
            config,
            access: input.access,
            agentIds: team ? team.agents.map((a) => a.id) : undefined,
            guide: input.guide,
            personId: context.person?.id,
          });
          return {
            integration: {
              id: integration.id,
              slug: integration.slug,
              name: integration.name,
              baseUrl: (integration.config as ApiConfig).baseUrl,
              fields: integration.config.fields,
              hasCredentials: integration.hasCredentials,
              status: integration.status,
            },
          };
        } catch (error) {
          if (error instanceof IntegrationError || error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not saved: ${output.error}`
            : `Saved ${output.integration.name} (${output.integration.slug}). ${
                output.integration.hasCredentials
                  ? "Its saved credentials were kept."
                  : "They now see a card to enter the credentials, which tests the connection. Don't ask for credentials in the chat."
              }`,
      }),
    }),
    connect_login: tool({
      description:
        "Connect (or reconfigure) a website account used in a sandbox's browser: by you (e.g. to read API docs behind a sign-in) and by the agents you name, for sites without an API or changes the API can't make. Shows the person a secure card for the username, password and, optionally, an authenticator setup key. Never put credentials in this call.",
      inputSchema: z.object({
        name: z.string().min(1).max(60).describe("e.g. Masttro (web)"),
        slug: z.string().optional().describe("Short handle, e.g. masttro-web. Reuse it to reconfigure."),
        description: z.string().describe("What agents do there."),
        loginUrl: z
          .string()
          .describe("The page with the sign-in form itself, e.g. https://app.masttro.com/login. Not a docs page or anything public."),
        checkUrl: z.string().optional().describe("A page that only shows when signed in, e.g. the dashboard."),
        domains: z
          .array(z.string())
          .optional()
          .describe("Every other site this account opens, e.g. a help centre on its own domain that signs in through it (masttro.zendesk.com)."),
        agents: z
          .array(z.string())
          .optional()
          .describe("Exact names of the agents allowed to use it besides you. Leave out when only you need it."),
        selectors: z
          .object({ username: z.string().optional(), password: z.string().optional(), submit: z.string().optional(), code: z.string().optional() })
          .optional()
          .describe("CSS selectors for the sign-in form, only if the usual ones won't find it."),
        guide: z.string().optional().describe("Markdown for agents: where things are on the site, how to enter data, what to avoid."),
      }),
      execute: async ({ agents: agentNames, ...input }) => {
        try {
          const team = await resolveTeam(orgId, { agents: agentNames ?? [] });
          const config: LoginConfig = {
            loginUrl: input.loginUrl,
            checkUrl: input.checkUrl,
            domains: input.domains ?? [],
            selectors: input.selectors,
            fields: [
              { name: "username", label: "Username or email", secret: false },
              { name: "password", label: "Password" },
              {
                name: "totp",
                label: "Authenticator setup key (lets agents answer sign-in codes themselves)",
                optional: true,
              },
            ],
          };
          const integration = await saveIntegration(orgId, {
            kind: "login",
            name: input.name,
            slug: input.slug,
            description: input.description,
            config,
            access: "write",
            agentIds: team.agents.map((a) => a.id),
            guide: input.guide,
            personId: context.person?.id,
          });
          return {
            integration: {
              id: integration.id,
              slug: integration.slug,
              name: integration.name,
              baseUrl: (integration.config as LoginConfig).loginUrl,
              fields: integration.config.fields,
              hasCredentials: integration.hasCredentials,
              status: integration.status,
              kind: "login" as const,
            },
            agents: team.agents.map((a) => a.name),
          };
        } catch (error) {
          if (error instanceof IntegrationError || error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not saved: ${output.error}`
            : `Saved ${output.integration.name} (${output.integration.slug}) for ${output.agents.length ? `you and ${output.agents.join(", ")}` : "you only"}. ${
                output.integration.hasCredentials
                  ? "Its saved credentials were kept."
                  : "They now see a card to enter the username and password. Don't ask for them in the chat."
              }`,
      }),
    }),
    create_agent: tool({
      description: "Create a defined agent: one with a standing role that does the same kind of work again and again.",
      inputSchema: z.object({
        name: z.string().min(1).max(40),
        role: z.string().describe("A few words, like a job title."),
        description: z.string().describe("What it is responsible for and what good work looks like."),
        instructions: z.string().describe("Specific do's and don'ts, sources, tone and formats."),
      }),
      execute: async (input) => {
        try {
          const agent = await createAgent(orgId, input);
          return { agent: { id: agent.id, name: agent.name } };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Couldn't create the agent." };
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: "error" in output ? `Not created: ${output.error}` : `Created ${output.agent.name}.`,
      }),
    }),
    suggest_profile_update: tool({
      description:
        "Suggest a change to one section of the company profile. They see it as a card and apply or dismiss it.",
      inputSchema: z.object({
        section: z.enum(sectionNames),
        content: z.string().describe("Full markdown body for the section, without the '## ' heading."),
        reason: z
          .string()
          .max(140)
          .describe("One sentence they read in their inbox, e.g. 'You use Masttro for reporting. Add it to How We Work?'"),
      }),
      execute: async ({ section, content, reason }) => {
        if (!context.person) return { error: "No signed-in person to review it." };
        try {
          const task = await suggestProfileUpdate(orgId, { personId: context.person.id }, { section, content, reason });
          return { suggestion: { id: task.id, number: task.number, section, content, reason } };
        } catch (error) {
          if (error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: "error" in output ? `Not suggested: ${output.error}` : "Suggested. It's waiting for them to apply.",
      }),
    }),
  } satisfies ToolSet;
}

const ONBOARDING_ONLY = ["set_company_name", "update_section", "complete_onboarding"] as const;
const AFTER_ONBOARDING_ONLY = ["suggest_profile_update"] as const;

/** Where the Chief of Staff works: no task, no agent record; its own workspace sandbox for the company. */
export function workspaceOf(context: Pick<Context, "organization" | "person">): AgentContext {
  return { organizationId: context.organization.id, taskId: null, agentId: null, agentName: "Chief of Staff", personId: context.person?.id };
}

/**
 * The Chief of Staff: the same agent toolkit as every agent (research, data
 * sources, a sandbox and its browser), working in the company's workspace,
 * plus its own tools for the company: the profile, people, tasks, agents and
 * integrations. Pass a sandbox session to close its sandbox when the turn ends.
 */
export function createChiefOfStaff(
  context: Context,
  options: { model?: LanguageModel; research?: boolean; sandbox?: SandboxSession } = {},
) {
  const model = options.model ?? process.env.CHIEF_OF_STAFF_MODEL;
  if (!model) {
    throw new Error("Set CHIEF_OF_STAFF_MODEL to an AI Gateway model id (see README).");
  }
  const workspace = workspaceOf(context);
  const using = sandboxUser(workspace, options.sandbox ?? {});
  const tools = {
    ...profileTools(context),
    ...workTools(context),
    ...integrationTools(workspace, using, null),
    ...sandboxTools(workspace, using),
    // A sign-in code goes from a card in the chat straight to the waiting browser.
    ...browserTools(workspace, using, null, (login) => ({
      text: `${login.name} sent a sign-in code. They now see a card to enter it, which hands it straight to your browser. Tell them, then wait until they say it's entered and call browser_login again (or continue the browser session, if it came from use_browser).`,
      needsCode: login,
    })),
    ...pageTools(workspace, using, { name: "Chief of Staff", personId: context.person?.id }),
    ...(options.research === false ? {} : researchTools()),
    use_skill: skillTool(),
  };
  // Every tool stays in the type (and in stored chats); only the ones that fit
  // the moment are offered to the model.
  const hidden: readonly string[] = context.organization.onboardingCompletedAt ? ONBOARDING_ONLY : AFTER_ONBOARDING_ONLY;
  return new ToolLoopAgent({
    model,
    instructions: chiefOfStaffInstructions(context),
    tools,
    activeTools: (Object.keys(tools) as (keyof typeof tools)[]).filter((name) => !hidden.includes(name)),
  });
}

export type ChiefOfStaffMessage = InferAgentUIMessage<ReturnType<typeof createChiefOfStaff>>;
