import "server-only";

import {
  ToolLoopAgent,
  tool,
  type InferAgentUIMessage,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";

import { actionCatalog } from "@/lib/actions";
import { planJob } from "@/lib/agents/planner";
import { roleModel } from "@/lib/ai/lineup";
import { actionTools } from "@/lib/agents/action-tools";
import { pageTools } from "@/lib/agents/page-tools";
import { appMapLines } from "@/lib/app-map";
import { invitePersonAs, OperationError, type Actor } from "@/lib/operations";
import { personAbout, personLine, type AgentContext } from "@/lib/agents/prompts";
import { appUrl } from "@/lib/app-url";
import { SKILLS, skillList } from "@/lib/agents/skills";
import {
  browserTools,
  githubTools,
  integrationTools,
  researchTools,
  sandboxTools,
  sandboxUser,
  skillTool,
  type SandboxSession,
  type SandboxUser,
} from "@/lib/agents/toolkit";
import { askSpecialist } from "@/lib/agents/specialist";
import { companyModel } from "@/lib/ai/company-model";
import { createAgent, findAgentByName, workerAgent, type Agent } from "@/lib/agents/store";
import { findFiles, listTaskFiles, type LibraryFile } from "@/lib/files";
import {
  IntegrationError,
  saveIntegration,
  type ApiConfig,
  type Integration,
  type LoginConfig,
} from "@/lib/integrations";
import { completeOnboarding, renameOrganization, type Organization } from "@/lib/orgs";
import { workOverview, type ScheduledJob } from "@/lib/work-overview";
import type { Page } from "@/lib/pages";
import { renamePerson, savePerson, syncPeopleSection, type Person } from "@/lib/people";
import {
  isCaptured,
  onboardingChecklist,
  PEOPLE_SECTION,
  SECTIONS,
  setCompanyName,
  setSection,
} from "@/lib/profile/markdown";
import { describeHours } from "@/lib/assistant/hours";
import { scheduleWakeup, type AssistantHours } from "@/lib/assistant/store";
import { getGitHubConnection } from "@/lib/github";
import { updateProfile } from "@/lib/profile/store";
import { describeSchedule, getSchedule } from "@/lib/schedules";
import type { SessionUser } from "@/lib/session";
import { findTasks, getTaskByNumber, isRunning, listMessages, PRIORITIES, TASK_STATUSES, type Task } from "@/lib/tasks";
import { createTaskWithTeam, replyToTask, resolveTeam, suggestProfileUpdate, WorkError } from "@/lib/work";
import { elapsed, taskState } from "@/lib/work-overview";

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
  /** Jobs that repeat on a schedule. */
  jobs?: ScheduledJob[];
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
  /** The GitHub account of the person you're talking to, if they connected one. */
  github?: { login: string; status: "connected" | "expired" } | null;
  /** Your notes about the person you're talking to (only you see them, only while talking with them). */
  memory?: string;
  /** A summary of the conversation before the messages you're shown in full. */
  earlier?: string;
  /** When the person you're talking to works and wants quiet, in their timezone. */
  hours?: AssistantHours | null;
  /** Whether the person you're talking to is one of the company's admins. */
  isAdmin?: boolean;
  /** Providers the company brought its own AI key for (Settings → AI). */
  aiKeys?: string[];
  /** Everyone on the Team page: whether they've joined Mach1 or been invited, and admins. */
  team?: { name: string; status: "active" | "invited" | "not_invited"; admin: boolean }[];
};

/** The person you're talking to, as the one doing things (lib/operations.ts). */
export function actorFor(context: Context): Actor | null {
  if (!context.person) return null;
  return {
    organizationId: context.organization.id,
    personId: context.person.id,
    name: context.person.name,
    userId: context.user.id,
    isAdmin: context.isAdmin ?? false,
  };
}

const ACKNOWLEDGE = `When they ask for something that takes more than a moment (several tool calls, research, browsing, building a page, starting a task or an agent, coding, anything multi-step), first write one short line saying you've got it and what you're doing ("On it: pulling Q3 from Masttro and checking it against the model."), then start the work, and finish with the answer. On WhatsApp and email that line goes out straight away, while you work. A quick question or a single quick action: just answer, no acknowledgement. Never acknowledge and then stop.`;

function channelInstructions(channel: Channel): string {
  const where = channel === "whatsapp" ? "WhatsApp" : "email";
  return `This message came by ${where}, and your reply goes back the same way, as plain text. Keep it short: a few sentences or a short list, no tables or headings${
    channel === "whatsapp" ? ", *single asterisks* for bold" : ""
  }. Cards don't show there: when a tool shows one (credentials for an integration, a sign-in code, a profile suggestion to apply), say so and give the link to the screen where they finish it, from the app's screens below. It's the same conversation as their chat panel in Mach1, so they can carry on in either.`;
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

Once those are done (or in the same breath as the last one), ask the one personal question you need to work for them: their timezone, working hours, and when you should stay quiet (see below). It isn't needed to complete onboarding.

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
  const { agents = [], openTasks = [], jobs = [], files = [], integrations = [], pages = [] } = context;
  const pageLines = pages
    .filter((p) => p.version > 0)
    .map((p) => `- ${p.slug}: ${p.title}, reads ${p.data.join(", ") || "no files"}${p.taskNumber ? `, refreshed by #${p.taskNumber}` : ", not refreshed on a schedule"}`);
  const integrationLines = integrations.map(
    (i) =>
      `- ${i.slug}: ${i.name} (${i.kind === "api" ? "data source" : "login"}, ${i.access === "read" ? "read-only" : "read and write"}, ${i.status.replace("_", " ")}${
        i.personIds ? `, ${i.personIds.length} ${i.personIds.length === 1 ? "person's" : "people's"} work only` : ""
      })${i.description ? `: ${i.description}` : ""}`,
  );
  const agentLines = agents
    .filter((a) => a.kind === "defined" && a.status === "active")
    .map((a) => `- ${a.name}${a.role ? ` (${a.role})` : ""}${a.description ? `: ${a.description}` : ""}`);
  const fileLines = files
    .filter((f) => f.kind === "deliverable" && f.versions.length)
    .slice(0, 30)
    .map((f) => {
      const v = f.versions[0];
      return `- ${f.name} (v${v.version}${v.taskNumber ? `, from #${v.taskNumber}` : ""})`;
    });
  return `Tasks and agents:
- When someone asks for work to be done ("do a review of…", "draft…", "find…"), create a task with create_task instead of doing the work in chat. Load the writing-tasks skill first. Put an agent on it: a defined agent whose role fits, or else the Worker (workerRole says what kind of work) with the skills the work needs pinned (skills). The agent starts straight away and reports back to their inbox; tell them that in one line.
- Answer quick questions yourself. Create a task only for real work.
- Work they ask for is theirs: private to them and the people on it unless you pass shareWithCompany. Share it when it's meant for everyone (a report for the family, company work others should follow) or they say so; keep it private when it's personal or they haven't decided. They can change it any time ("share #12 with the company"): task.set_visibility.
- A big job (several steps or agents, several deliverables, days of work) gets planned first with plan_job (acknowledge first: it takes a minute or two). If the plan has things to ask first, ask them in one message and wait. Otherwise create its steps as tasks with create_task, each with its agent or a workerRole, and later steps with after set to the numbers of the tasks they need: they start by themselves as those are delivered. Then tell them the plan in a few lines with the task numbers. Everyday requests: just create the task.
- A question that needs one of the defined agents' expertise (the analyst on a number, the lawyer on a clause) goes to it with ask_specialist rather than you guessing: it answers in a few minutes on a model chosen for that work, or it becomes a task for it. Answer everyday questions yourself.
- If the same kind of work will keep coming up and no agent fits, offer to create a defined agent with create_agent (load the designing-agents skill first).
- For work that should happen regularly ("every weekday at 4pm chart the option flow", "each Monday summarise…"), pass repeat on create_task. It runs once now and then on the schedule, every run landing on the same task, in the same sandbox, so tell them that. Use the timezone they mention, else the company's (${context.organization.timezone ?? "not known yet: ask"}). Use mode script when code can do the job (data pulls, charts, models: the agent builds run.sh once and later runs replay it cheaply), agent when each run needs judgment. To change an existing job's schedule, tell them to reply on its task or use the Repeats panel there.
- Jobs share a company data drive: datasets one job saves there are available to every other job.

Defined agents (who they are):
${agentLines.join("\n") || "(none yet)"}

The company's work right now (live, as of this message). You see all of it: everyone's tasks, every agent and every scheduled job. When someone asks what's going on, how something is going, or what an agent found, answer from here, and use read_task for the detail (its summary, progress, thread and results) rather than guessing. find_tasks searches all work, finished included. To steer work (tell an agent to change course, answer its question, add a detail), use reply_on_task: it posts on the task as the person you're talking to, which wakes or queues its agent. Only post what they asked you to.
${workOverview({ openTasks, agents, jobs })}

Integrations: the company's other systems, connected so agents can use them without seeing credentials. When someone wants a system connected ("connect Masttro, here are the API docs"), load the connecting-integrations skill and set it up yourself, in this chat: read the docs (with your browser if they need a sign-in), then connect_data_source; they enter credentials in the cards the tools show, never in the chat. Never create an agent or a task to set up an integration. Answer quick questions from a connected data source with call_api. For a website with no API, or changes its API can't make (data entry in Masttro, say), connect a login with connect_login; every agent can use it, signing in with the browser in its sandbox, and sign-in codes come to the people on the job.

Your sandbox: like every agent, you have a Linux sandbox for the company with a browser in it. Use browse to read pages fetch_page can't (JavaScript apps, pages behind one of the company's logins), and run_code to work through what you saved (an API spec, say). For anything interactive on a website (checking something inside a signed-in app, testing a login, a quick change people asked for), hand it to the browser agent with use_browser: it sees the page, signs in with the company's logins and reports back with screenshots. It's for quick things while you set things up or answer a question; real work still goes to a task.
${integrationLines.join("\n") || "(none yet)"}

Code and GitHub: each person connects their own GitHub (Settings → Account), and work in GitHub always runs as the person who asked, never anyone else. ${githubLine(context)}
- For a code change in a repository ("fix the typo on the pricing page", "add a field to the signup form"), call start_coding with what they want and the repository if they named it. The Worker, with the coding-in-github skill, clones it, works on a branch, runs its checks, pushes and opens a pull request, then reports back with the link (on WhatsApp too, when they asked there). Don't write code in chat.
- Follow-ups on that work ("also make the button blue", "merge it") go to its task with reply_on_task. Merging happens only when they say so.
- Quick questions about their GitHub (their open pull requests, a repository's recent commits, an issue) answer yourself with github_api, which acts as them.

Research: the Worker, with the research skill, looks into anything the company needs to know (companies and markets, people and organisations, products and vendors, topics and events) across the web, filings, market data, X and Reddit, starting with the sources each person saved as high signal.
- Everyday lookups answer yourself: a price or a quick number (market_data), what one account or a few are saying (x_search), a fact (web_search).
- A question that needs judgment across several sources ("what's the market saying about Micron's guidance?", "is this vendor any good?") goes to start_research with depth quick: it answers here in a few minutes. Real research ("a brief on…", "dig into…", "compare…", due diligence, a primer) is depth brief: a task it reports back on with a written, sourced brief. A regular digest ("every Monday, what my sources say about AI chips") is a brief with repeat.
- Brief it like a good manager: it gets the company profile and who it's for (their name and role) by itself, but it can't see this conversation. Say why they want it (the decision or work it's for), what matters that it can't know (what they already know or think, constraints, names, tickers or links they gave, sources to use or avoid) and what they want back. Pass on only what the research needs, nothing personal it doesn't.
- High-signal sources: when someone says a website, an X account, a subreddit or a Reddit user is worth following, or to look at it first, save it with do_action source.add, with why in the note (theirs unless they say it's for everyone). source.list shows them; the Research screen has them too.

Pages: views of the company's data that people keep coming back to (a dashboard of net worth by entity, cash across banks), in Pages and kept up to date. When someone asks for a dashboard, a view, a page or to "see X every morning", load the building-pages skill and build it yourself in this chat: data into files on the drive with a script, the page with save_page, and refresh_page to keep it fresh. Not for one-off answers. A page you build is theirs until it's shared: when it's meant for everyone (a report for the family, the company's numbers) or they say so, share it with share_page.
${pageLines.join("\n") || "(no pages yet)"}

Company files (newest first). When a request builds on one ("add a 70/30 case to the portfolio model"), pass it in create_task's files so the job starts from it and saves its next version; if the job that made it is still open, prefer replying there instead of creating a new task:
${fileLines.join("\n") || "(none yet)"}`;
}

function appInstructions(context: Context): string {
  const name = context.person?.name ?? context.user.name;
  const team = (context.team ?? []).map(
    (p) => `- ${p.name}: ${p.status === "active" ? "joined" : p.status === "invited" ? "invited, not joined yet" : "not invited"}${p.admin ? ", admin" : ""}`,
  );
  return `The app: you can do from chat everything ${name} can do on Mach1's screens, as them and with their permissions (${
    context.isAdmin ? "they're an admin" : "they're a member, not an admin: inviting and removing people, roles, whose work may use an integration and the company's models are for admins"
  }). Besides your own tools (create_task, reply_on_task, save_person, create_agent, connect_data_source, connect_login, pages…), everything people do on the screens is an action you perform with do_action, by name with its inputs. Files people send you by WhatsApp or email, or attach in the chat, are saved to Files, private to them, and shown to you with their message. When an action is refused, say why in a line. The actions:
${actionCatalog({ isAdmin: Boolean(context.isAdmin) })}
${claudeLine(context)}Never through chat, whoever asks: credentials, passwords and API keys (integrations, AI provider keys), deleting the company, and linking their WhatsApp. For those, and whenever someone needs to see or do something on a screen, give the exact link from this list (fill in {placeholders}) and where it is in the menus. Never just the home page.
${appMapLines()}

The team in Mach1 (who has joined):
${team.join("\n") || "(no one yet)"}`;
}

/** Admins of a company without an Anthropic key hear, once, that adding one runs Claude (faster for you). */
function claudeLine({ isAdmin, aiKeys, organization }: Context): string {
  if (!isAdmin || !aiKeys || aiKeys.includes("anthropic") || !organization.onboardingCompletedAt) return "";
  return `Mach1 runs on OpenAI for this company. Once, when it fits (after onboarding, not mid-task), suggest they add the company's Anthropic API key in Settings → AI (${appUrl("/settings/ai")}): you and their agents then run on Claude, which replies faster, billed to their Anthropic account. The key comes from console.anthropic.com; a Claude Team or Enterprise plan doesn't include one. They add it there themselves, never in chat. Don't bring it up again once they've heard it.\n`;
}

function githubLine({ github, person }: Context): string {
  if (!person) return "";
  if (github?.status === "connected") return `${person.name}'s GitHub is connected as @${github.login}.`;
  return `${person.name} ${github ? "needs to reconnect their GitHub" : "hasn't connected GitHub yet"}: before any GitHub work, send them ${appUrl("/connect/github")} to connect theirs (a minute; they choose which repositories Mach1 may use), then carry on once they say it's done.`;
}

/** What you know about the person you're talking to, and your conversation with them so far. */
function hoursLine({ person, hours }: Context): string {
  if (!person || !hours) return "";
  if (hours.saved) return `${person.name}'s hours: ${describeHours(hours.hours, hours.timezone)}. If they change them, save the new ones with do_action me.set_hours.`;
  return `You don't know ${person.name}'s hours yet (until you do, you assume ${describeHours(hours.hours, hours.timezone)}). Early on, when it fits, ask once in one short question which timezone they're in, when they work, and when you should never message them, proposing those defaults so a "yes" will do; save the answer with do_action me.set_hours. Don't ask again if they skip it.`;
}

function personalInstructions(context: Context): string {
  const { person, memory, earlier } = context;
  if (!person) return "";
  return `
You are ${person.name}'s own assistant as well as the company's Chief of Staff: you work on their behalf, and for the company through them.

What you know about ${person.name} (your notes; only you see them, and only while talking with them):
${memory?.trim() || "(nothing yet)"}
Keep these notes current (do_action me.set_notes, which replaces them, so keep what's still true; short bullet points) when you learn something lasting about them: how they like answers, what they look after, who and what they care about, what you're following up on for them. Facts about the company go in the profile instead. Never put credentials in notes.

${hoursLine(context)}
You wake up by yourself to tell them when work of theirs is done or needs them, and you can set yourself a check-in with check_back_later ("I'll check on the import at 4 and tell you"): use it whenever you promise to come back to something or are waiting on work they care about, then keep the promise. You never message them in their quiet hours, and anything that can wait goes in their working hours.
${earlier?.trim() ? `\nEarlier in your conversation with ${person.name} (a summary; the latest messages follow in full):\n${earlier.trim()}\n` : ""}`;
}

export function chiefOfStaffInstructions(context: Context): string {
  const { organization, user, profile } = context;
  const today = new Date().toISOString().slice(0, 10);
  return `You are the Chief of Staff of ${organization.name}, a company that uses Mach1, a command center where people and AI agents run the business together.

You are talking to ${context.person?.name ?? user.name} (${user.email}), who is already in the people list under that name. If you learn their role or manager, save it.
${personalInstructions(context)}
${organization.onboardingCompletedAt ? afterOnboardingInstructions(context) : onboardingInstructions(context)}

${workInstructions(context)}

${ACKNOWLEDGE}
${context.channel ? `\n${channelInstructions(context.channel)}\n` : ""}${
    context.viewing
      ? `\nRight now they're looking at ${context.viewing} in Mach1, with this chat open beside it. When they say "this", "here" or "it" without saying what, they mean that.\n`
      : ""
  }
${appInstructions(context)}

Recording facts:
- The company profile below is a markdown document and your memory of the company. Record facts as soon as you learn them; don't ask permission to save.
- Write in the company's own words, concise and factual. Never invent facts.
- Use save_person for people (person.remove takes someone off the team). To change someone's name (including the person you're talking to), call save_person with their current name and newName; never remove someone and add them again, which would take them off their tasks. Never write the "${PEOPLE_SECTION}" section with update_section; it is generated from the people list.
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
        phone: z.string().optional().describe("Phone number, as contact details. It never lets anyone message you as them: people link their own WhatsApp in Settings → Account."),
        invite: z.boolean().optional().describe("Also invite them to Mach1 by email (admins; they need an email)."),
      }),
      execute: async ({ reportsTo, newName, invite, ...person }) => {
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
        const saved = await savePerson(orgId, { ...person, name, managerName: reportsTo });
        const profile = await syncPeopleSection(orgId);
        const actor = actorFor(context);
        if (!invite || !actor) return { profile };
        try {
          return { profile, invited: await invitePersonAs(actor, saved.id) };
        } catch (error) {
          if (error instanceof OperationError) return { profile, invited: `Saved, but not invited: ${error.message}` };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: "error" in output && output.error ? `Not saved: ${output.error}` : "invited" in output && output.invited ? `Saved. ${output.invited}` : "Saved.",
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

/**
 * What the Researcher is asked, from the chat: it can't see the conversation,
 * so why it's wanted, what matters and what to hand back travel with the question.
 */
export function researchRequest(
  asked: { question: string; purpose: string; context?: string; deliverable?: string },
  person: Person,
): string {
  return [
    asked.question.trim(),
    `Why: ${asked.purpose.trim()}`,
    `For: ${personLine(person)}`,
    asked.context?.trim() ? `What matters: ${asked.context.trim()}` : "",
    asked.deliverable?.trim() ? `What they want back: ${asked.deliverable.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type ResearchOutput =
  | { error: string }
  | { agent: string; answer: string }
  | { agent: string; task: number; why: string }
  | { agent: string; task: number; repeats: string | null };

function workTools(context: Context, research: { workspace: AgentContext; using: SandboxUser; enabled: boolean }) {
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
          .describe("Put the Worker on it for this kind of work, e.g. 'Financial analysis', when no defined agent fits."),
        skills: z
          .array(z.enum(SKILLS.map((s) => s.name) as [string, ...string[]]))
          .optional()
          .describe("Skills the work needs (e.g. research, excel-models, presentations, data-pipelines): its agent reads them before it starts."),
        files: z.array(z.string()).optional().describe("Exact names of company files the job should start from."),
        shareWithCompany: z
          .boolean()
          .optional()
          .describe("Share it with the whole company: work meant for everyone, or company work they want visible. Otherwise only they and the people on it see it."),
        repeat: z
          .object({
            cron: z.string().describe("Five-field cron in the timezone, e.g. '0 16 * * 1-5' for weekdays at 16:00."),
            timezone: z.string().describe("IANA timezone, e.g. Europe/London."),
            mode: z.enum(["script", "agent"]).describe("script: replay the job's run.sh each time. agent: the agent does the job each time."),
          })
          .optional()
          .describe("Makes it a recurring job. The first run starts now."),
        after: z
          .array(z.number().int().positive())
          .optional()
          .describe("Numbers of tasks it needs first (a planned job's later steps): it waits, then starts by itself once each is delivered."),
      }),
      execute: async ({ title, description, priority, people, agents, workerRole, skills, files, repeat, shareWithCompany, after }) => {
        try {
          const found = await findFiles(orgId, files ?? [], { viewer: context.person?.id });
          const missing = (files ?? []).filter((name) => !found.some((f) => f.name.toLowerCase() === name.trim().toLowerCase()));
          if (missing.length) throw new WorkError(`No company file called ${missing.join(", ")}.`);
          const team = await resolveTeam(orgId, { people, agents });
          const first = await Promise.all((after ?? []).map((number) => getTaskByNumber(orgId, number, { viewer: context.person?.id })));
          const unknown = (after ?? []).filter((_, i) => !first[i]);
          if (unknown.length) throw new WorkError(`There's no task #${unknown.join(", #")}.`);
          const task = await createTaskWithTeam(orgId, {
            title,
            description,
            priority,
            personIds: team.people.map((p) => p.id),
            agentIds: team.agents.map((a) => a.id),
            workerRole,
            skills,
            inputFileIds: found.map((f) => f.id),
            schedule: repeat,
            visibility: shareWithCompany ? "company" : "private",
            after: first.map((t) => t!.id),
            by,
          });
          return {
            task: { id: task.id, number: task.number, title: task.title, waitsFor: task.status === "backlog" ? task.waitsFor : [] },
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
            : `Created task #${output.task.number} with ${output.members.join(", ")}.${output.repeats ? ` Repeats: ${output.repeats}.` : ""}${
                // Tasks created before tasks could wait were stored without it, and old results are replayed.
                output.task.waitsFor?.length ? ` It starts once #${output.task.waitsFor.join(" and #")} ${output.task.waitsFor.length > 1 ? "are" : "is"} delivered.` : ""
              }`,
      }),
    }),
    start_coding: tool({
      description:
        "Start a code change in a GitHub repository, done by the Worker with the coding-in-github skill as the person you're talking to (with their own GitHub): a task it works on straight away, ending in a pull request. They're on it and hear back when it's ready.",
      inputSchema: z.object({
        title: z.string().min(1).max(100).describe("The change, starting with a verb, e.g. 'Fix the typo on the pricing page'."),
        request: z.string().min(1).describe("What they want, in their words plus anything you know: where, why, what done looks like."),
        repository: z.string().optional().describe("owner/name, if they said which; the agent finds it otherwise."),
      }),
      execute: async ({ title, request, repository }) => {
        if (!context.person) return { error: "Only a signed-in team member can start code changes." };
        const github = await getGitHubConnection(orgId, context.person.id);
        if (github?.status !== "connected") {
          return { error: `${context.person.name} needs to connect their GitHub first: ${appUrl("/connect/github")}` };
        }
        const developer = await workerAgent(orgId);
        const task = await createTaskWithTeam(orgId, {
          title,
          description: [request.trim(), repository ? `Repository: ${repository.trim()}` : ""].filter(Boolean).join("\n\n"),
          agentIds: [developer.id],
          skills: ["coding-in-github"],
          replyByWhatsApp: context.channel === "whatsapp",
          by,
        });
        return { task: { number: task.number, title: task.title }, agent: developer.name, github: github.login };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not started: ${output.error}`
            : `Started task #${output.task.number}: ${output.agent} is on it as @${output.github}. It reports back with a pull request${context.channel === "whatsapp" ? ", here on WhatsApp too" : ""}.`,
      }),
    }),
    start_research: tool({
      description:
        "Hand research to the Worker with the research skill (companies, markets, people, products, topics, events): it searches the web, filings, market data, X and Reddit, starting with the sources the person you're talking to saved as high signal. It gets the company profile and who it's for by itself; everything else from this conversation it only knows from what you pass here. quick: it answers here in a few minutes (or it becomes a task if it needs longer). brief: a task where it investigates in depth and reports back with a sourced brief, on WhatsApp too when they asked there.",
      inputSchema: z.object({
        title: z.string().min(1).max(100).describe("Starting with a verb, e.g. 'Research Micron's HBM outlook'."),
        question: z.string().min(1).describe("What to find out, in a sentence or two."),
        purpose: z
          .string()
          .min(1)
          .describe(
            "Why they want it: the decision or work it's for, e.g. 'deciding whether to add to our MU position' or 'choosing a CRM for a team of 12'. If they didn't say, your best understanding from the conversation and the company profile.",
          ),
        context: z
          .string()
          .optional()
          .describe(
            "What matters that the research can't see: what they already know or think, constraints (budget, region, time frame), names, tickers and links from the conversation, sources to use or avoid. Only what the research needs.",
          ),
        deliverable: z.string().optional().describe("What they want back, e.g. 'a one-page brief', 'a table of five vendors', 'yes or no, with the reasons'."),
        depth: z.enum(["quick", "brief"]).describe("quick: a question answered in minutes. brief: in-depth research delivered as a written brief."),
        shareWithCompany: z.boolean().optional().describe("Research meant for everyone. Otherwise only they and the people on it see it."),
        repeat: z
          .object({
            cron: z.string().describe("Five-field cron in the timezone, e.g. '0 8 * * 1' for Mondays at 08:00."),
            timezone: z.string().describe("IANA timezone, e.g. Europe/London."),
          })
          .optional()
          .describe("For a brief that repeats (a weekly digest). The first one starts now."),
      }),
      execute: async ({ title, depth, shareWithCompany, repeat, ...asked }): Promise<ResearchOutput> => {
        if (!context.person) return { error: "Only a signed-in team member can start research." };
        const researcher = await workerAgent(orgId);
        const request = researchRequest(asked, context.person);
        // A quick question is answered while you wait; one that needs longer becomes a task, as a brief does.
        let why: string | undefined;
        if (depth === "quick" && !repeat) {
          const answered = await askSpecialist(research.workspace, research.using, researcher, context.organization.models ?? {}, {
            question: request,
            askedBy: context.person.name,
            about: personAbout(context.person),
            profile: context.profile,
            research: research.enabled,
            skills: ["research"],
          });
          if ("answer" in answered) return { agent: researcher.name, answer: answered.answer };
          why = answered.needsTask;
        }
        try {
          const task = await createTaskWithTeam(orgId, {
            title,
            description: request,
            agentIds: [researcher.id],
            skills: ["research"],
            replyByWhatsApp: context.channel === "whatsapp",
            visibility: shareWithCompany ? "company" : "private",
            schedule: repeat ? { ...repeat, mode: "agent" } : undefined,
            by,
          });
          if (why) return { agent: researcher.name, task: task.number, why };
          return { agent: researcher.name, task: task.number, repeats: repeat ? describeSchedule(repeat.cron, repeat.timezone) : null };
        } catch (error) {
          if (error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not started: ${output.error}`
            : "answer" in output
              ? `${output.agent} says:\n${output.answer}`
              : "why" in output
                ? `${output.agent} needs longer (${output.why}), so it's now task #${output.task}, which it has started; they'll hear when it's done. Tell them in one line.`
                : `Started task #${output.task}: ${output.agent} is on it and reports back with a brief${context.channel === "whatsapp" ? ", here on WhatsApp too" : ""}.${output.repeats ? ` Repeats: ${output.repeats}.` : ""}`,
      }),
    }),
    check_back_later: tool({
      description:
        "Wake yourself up later to check on something and tell the person you're talking to how it went (a job you're waiting on, something you promised to come back to, an answer they owe someone). At that time you look into it and message them, or stay quiet if there's nothing to say. Moved out of their quiet hours.",
      inputSchema: z.object({
        about: z.string().min(1).max(500).describe("What to check and what to tell them, e.g. 'Whether #14's import finished; send the totals'."),
        minutes: z.number().int().min(5).max(60 * 24 * 14).optional().describe("How many minutes from now."),
        at: z.string().optional().describe("Or an exact time, ISO 8601 with offset, e.g. 2026-10-12T16:00:00+01:00."),
        task: z.number().int().positive().optional().describe("The task it's about, if any."),
        urgent: z.boolean().optional().describe("True if it can go outside their working hours (still never in quiet hours)."),
      }),
      execute: async ({ about, minutes, at, task, urgent }) => {
        if (!context.person) return "There's no one signed in to check back with.";
        const when = at ? new Date(at) : new Date(Date.now() + (minutes ?? 60) * 60_000);
        if (Number.isNaN(when.getTime())) return `${at} isn't a time I can read. Use ISO 8601, e.g. 2026-10-12T16:00:00+01:00.`;
        const found = task ? await getTaskByNumber(orgId, task, { viewer: context.person.id }) : null;
        const dueAt = await scheduleWakeup(orgId, context.person.id, {
          reason: "check_in",
          note: found ? `#${found.number}: ${about}` : about,
          urgent: urgent ?? true,
          at: when,
        });
        return `You'll wake up at ${dueAt.toISOString()} to check: ${about}`;
      },
    }),
    find_tasks: tool({
      description:
        "Search all of the company's work: open and (with include_closed) finished tasks, by words in the title, description, summary or thread, a task number, a status, or someone on it.",
      inputSchema: z.object({
        query: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        member: z.string().optional().describe("Exact name of a person or agent on it."),
        include_closed: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ include_closed, ...filters }) => {
        const tasks = await findTasks(orgId, { ...filters, includeClosed: include_closed, viewer: context.person?.id });
        const now = Date.now();
        return tasks.length
          ? tasks
              .map(
                (t) =>
                  `#${t.number} ${t.title} [${t.status}; ${taskState(t, now)}; updated ${elapsed(t.updatedAt, now)} ago] · ${t.members.map((m) => m.name).join(", ") || "no one"}${t.summary ? `\n  ${t.summary.slice(0, 200)}` : ""}`,
              )
              .join("\n")
          : "No tasks match.";
      },
    }),
    read_task: tool({
      description: "Read one task in full: what it's for, its status and what's happening on it now, its summary and progress, schedule, files, and the latest of its thread (questions, updates, results).",
      inputSchema: z.object({ number: z.number().int().positive(), messages: z.number().int().min(1).max(40).optional().describe("How many of the latest thread messages (default 12).") }),
      execute: async ({ number, messages: count = 12 }) => {
        const task = await getTaskByNumber(orgId, number, { viewer: context.person?.id });
        if (!task) return `There's no task #${number}.`;
        const [thread, schedule, files] = await Promise.all([listMessages(task.id), getSchedule(task.id), listTaskFiles(orgId, task.id)]);
        const now = Date.now();
        const latest = thread.slice(-count);
        return [
          `#${task.number} ${task.title} (${appUrl(`/tasks/${task.number}`)})`,
          `Status: ${task.status}; ${taskState(task, now)}. Priority ${task.priority}. Updated ${elapsed(task.updatedAt, now)} ago.${task.archivedAt ? " Archived." : ""}`,
          `On it: ${task.members.map((m) => `${m.name}${m.type === "agent" ? " (agent)" : ""}`).join(", ") || "no one"}`,
          task.summary ? `Summary: ${task.summary}` : "",
          task.options.length ? `Options offered: ${task.options.map((o) => `${o.label}${o.recommended ? " (recommended)" : ""}`).join("; ")}` : "",
          task.progress ? `Progress:\n${task.progress}` : "",
          schedule ? `Schedule: ${schedule.paused ? "paused" : schedule.description}, ${schedule.mode}; last ran ${schedule.lastRunAt ? `${elapsed(schedule.lastRunAt, now)} ago` : "never"}.` : "",
          `Description:\n${task.description.slice(0, 3000)}`,
          files.length ? `Files: ${files.map((f) => `${f.name} (v${f.versions[0]?.version ?? 1}${f.role === "input" ? ", input" : ""})`).join(", ")}` : "",
          `Thread (${latest.length} of ${thread.length}, oldest first):`,
          ...latest.map((m) => `- ${m.author}${m.kind !== "comment" ? ` [${m.kind}]` : ""}, ${elapsed(m.createdAt, now)} ago: ${m.body.slice(0, 1500)}`),
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
    reply_on_task: tool({
      description:
        "Post a message on a task's thread as the person you're talking to, e.g. to tell its agent to change course, answer its question or add a detail. It wakes the task's agent, or queues for it if it's working. Only post what they asked you to say; @Name mentions work as in the thread.",
      inputSchema: z.object({ number: z.number().int().positive(), message: z.string().min(1).max(4000) }),
      execute: async ({ number, message }) => {
        const task = await getTaskByNumber(orgId, number, { viewer: context.person?.id });
        if (!task) return { error: `There's no task #${number}.` };
        const working = isRunning(task);
        try {
          const after = await replyToTask(orgId, task.id, by, message);
          const agent = after.members.find((m) => m.type === "agent" && m.id === (after.runAgentId ?? undefined))?.name;
          return {
            posted: true,
            number,
            note: working
              ? "Its agent is working: it reads this when it finishes what it's doing."
              : after.status === "ready" || isRunning(after)
                ? `${agent ?? "Its agent"} is picking it up.`
                : "Posted; no agent was woken (it's for people, or no agent is on it).",
          };
        } catch (error) {
          if (error instanceof WorkError) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: "error" in output ? `Not posted: ${output.error}` : `Posted on #${output.number}. ${output.note}`,
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
        headers: z.object({}).catchall(z.string()).optional().describe('Templates, e.g. { "Authorization": "Bearer {{apiKey}}" }.'),
        query: z.object({}).catchall(z.string()).optional().describe('Query parameter templates, e.g. { "api_key": "{{apiKey}}" }.'),
        token: z
          .object({
            url: z.string(),
            method: z.enum(["POST", "GET"]).optional(),
            format: z.enum(["json", "form"]).optional(),
            body: z.object({}).catchall(z.string()).optional(),
            headers: z.object({}).catchall(z.string()).optional(),
            path: z.string().describe("Where the token is in the JSON response, e.g. access_token."),
            expiresInPath: z.string().optional(),
            ttlSeconds: z.number().optional(),
          })
          .optional()
          .describe("When the API swaps credentials for a short-lived token first; then sign requests with {{token}}."),
        testPath: z.string().optional().describe("A cheap GET that succeeds when the credentials work."),
        docsUrl: z.string().optional(),
        access: z.enum(["read", "write"]).optional().describe("read (the default): agents can only GET."),
        guide: z.string().optional().describe("Markdown for agents: main endpoints and parameters, paging, limits, field meanings."),
      }),
      execute: async (input) => {
        try {
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
        "Connect (or reconfigure) a website account used in a sandbox's browser, by you (e.g. to read API docs behind a sign-in) and by every agent, for sites without an API or changes the API can't make. Shows the person a secure card for the username, password and, optionally, an authenticator setup key. Never put credentials in this call.",
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
        selectors: z
          .object({ username: z.string().optional(), password: z.string().optional(), submit: z.string().optional(), code: z.string().optional() })
          .optional()
          .describe("CSS selectors for the sign-in form, only if the usual ones won't find it."),
        guide: z.string().optional().describe("Markdown for agents: where things are on the site, how to enter data, what to avoid."),
      }),
      execute: async (input) => {
        try {
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

type SpecialistOutput = { error: string } | { agent: string; answer: string } | { agent: string; task: number; why: string };

/** Quick questions for the company's agents, answered while you wait, or turned into a task when they need longer. */
function specialistTools(context: Context, workspace: AgentContext, using: SandboxUser, research: boolean) {
  const orgId = context.organization.id;
  const names = (context.agents ?? []).filter((a) => a.kind === "defined" && a.status === "active").map((a) => a.name);
  return {
    plan_job: tool({
      description:
        "Think a big job through before starting it (several steps or agents, several deliverables, days of work, or they ask you to plan): the company's planner, a stronger model, writes what to ask first, the steps, who does each and which wait for which. Takes a minute or two.",
      inputSchema: z.object({
        request: z.string().min(1).describe("The whole job in their words plus everything you know (deadlines, files, who's involved): the planner can't see your conversation."),
      }),
      execute: async ({ request }) =>
        planJob(orgId, {
          request,
          askedBy: context.person?.name ?? context.user.name,
          profile: context.profile,
          agents: context.agents ?? [],
          integrations: context.integrations ?? [],
          files: context.files ?? [],
          openTasks: context.openTasks ?? [],
        }),
    }),
    ask_specialist: tool({
      description:
        "Ask one of the company's defined agents a question that needs its expertise, and wait for the answer (a few minutes at most): it works on its own model, with its instructions and the data sources it may use. For questions, not jobs. If it needs longer, it becomes a task for that agent, which reports back.",
      inputSchema: z.object({
        agent: z.string().min(1).describe(`Exact name of a defined agent${names.length ? `: ${names.join(", ")}` : ""}.`),
        question: z.string().min(1).describe("The whole question with everything it needs to know: it can't see your conversation."),
        title: z.string().min(1).max(100).describe("A task title for it, starting with a verb, in case it needs longer."),
      }),
      execute: async ({ agent: name, question, title }): Promise<SpecialistOutput> => {
        const agent = await findAgentByName(orgId, name);
        if (!agent || agent.kind !== "defined" || agent.status !== "active") return { error: `There's no active agent called ${name}.` };
        const asked = await askSpecialist(workspace, using, agent, context.organization.models ?? {}, {
          question,
          askedBy: context.person?.name ?? context.user.name,
          about: context.person && personAbout(context.person),
          profile: context.profile,
          research,
        });
        if ("answer" in asked) return { agent: agent.name, answer: asked.answer };
        const task = await createTaskWithTeam(orgId, {
          title,
          description: question,
          agentIds: [agent.id],
          replyByWhatsApp: context.channel === "whatsapp",
          by: { name: context.user.name, personId: context.person?.id },
        });
        return { agent: agent.name, task: task.number, why: asked.needsTask };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? output.error
            : "answer" in output
              ? `${output.agent} says:\n${output.answer}`
              : `${output.agent} needs longer (${output.why}), so it's now task #${output.task}, which ${output.agent} has started; they'll hear when it's done. Tell them in one line.`,
      }),
    }),
  } satisfies ToolSet;
}

const ONBOARDING_ONLY = ["set_company_name", "update_section", "complete_onboarding"] as const;
const AFTER_ONBOARDING_ONLY = ["suggest_profile_update"] as const;

/** Where the Chief of Staff works: no task, no agent record; the own sandbox of the person it's talking with. */
export function workspaceOf(context: Pick<Context, "organization" | "person">): AgentContext {
  return { organizationId: context.organization.id, taskId: null, agentId: null, agentName: "Chief of Staff", personId: context.person?.id };
}

/**
 * The Chief of Staff: the same agent toolkit as every agent (research, data
 * sources, a sandbox and its browser), working in the person's own sandbox,
 * plus its own tools for the company: the profile, people, tasks, agents and
 * integrations. Pass a sandbox session to close its sandbox when the turn ends.
 */
export function createChiefOfStaff(
  context: Context,
  options: { model?: LanguageModel; research?: boolean; sandbox?: SandboxSession } = {},
) {
  const model = options.model ?? (context.organization.models?.chiefOfStaff || roleModel("chat"));
  const workspace = workspaceOf(context);
  const using = sandboxUser(workspace, options.sandbox ?? {});
  const tools = {
    ...profileTools(context),
    ...workTools(context, { workspace, using, enabled: options.research !== false }),
    ...integrationTools(workspace, using, null),
    ...sandboxTools(workspace, using),
    // A sign-in code goes from a card in the chat straight to the waiting browser.
    ...browserTools(workspace, using, null, (login) => ({
      text: `${login.name} sent a sign-in code. They now see a card to enter it, which hands it straight to your browser. Tell them, then wait until they say it's entered and call browser_login again (or continue the browser session, if it came from use_browser).`,
      needsCode: login,
    })),
    ...pageTools(workspace, using, { name: "Chief of Staff", personId: context.person?.id }),
    ...githubTools(workspace),
    ...specialistTools(context, workspace, using, options.research !== false),
    ...actionTools(actorFor(context), { whatsapp: context.channel === "whatsapp" ? context.person?.whatsapp : null }),
    ...(options.research === false ? {} : researchTools(workspace)),
    use_skill: skillTool(),
  };
  // Every tool stays in the type (and in stored chats); only the ones that fit
  // the moment are offered to the model.
  const hidden: readonly string[] = context.organization.onboardingCompletedAt ? ONBOARDING_ONLY : AFTER_ONBOARDING_ONLY;
  return new ToolLoopAgent({
    model: companyModel(context.organization.id, model),
    instructions: chiefOfStaffInstructions(context),
    tools,
    activeTools: (Object.keys(tools) as (keyof typeof tools)[]).filter((name) => !hidden.includes(name)),
  });
}

export type ChiefOfStaffMessage = InferAgentUIMessage<ReturnType<typeof createChiefOfStaff>>;
