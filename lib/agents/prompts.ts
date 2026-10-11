import type { Agent } from "@/lib/agents/store";
import { pinnedSkills, skillList, SKILLS, type Skill } from "@/lib/agents/skills";
import type { DriveFile } from "@/lib/drive";
import type { ApiConfig, Integration, LoginConfig } from "@/lib/integrations";
import type { Organization } from "@/lib/orgs";
import type { Schedule } from "@/lib/schedules";
import type { Task, TaskMessage } from "@/lib/tasks";

// What an agent reads when it works a task: its instructions, the company
// profile and everything on the task. Plain functions, so they can run in a
// workflow, a step or a test alike.

/** Agent runs allowed in a row before a person has to step in again. */
export const MAX_AGENT_TURNS = 6;
/** A job's coordinator wakes for each batch of its children, so it gets more turns before a person must step in. */
export const MAX_COORDINATOR_TURNS = 30;

/** People read the summary as one line in their inbox. */
export const SUMMARY_MAX = 140;

export type RunOutcome =
  | { type: "asked" }
  | { type: "finished" }
  | { type: "handed_off"; agentId: string }
  /** A job's coordinator ended its run to wait for its children. */
  | { type: "waiting" }
  /** A person sent a message with Send now: the run stopped so it can start again with it. */
  | { type: "interrupted" }
  | { type: "busy" }
  | { type: "skipped"; reason: string }
  | { type: "failed"; error: string };

/**
 * Who an agent is and where it works, for the tools every agent shares
 * (sandbox, browser, data sources): an agent on a task works in that job's
 * sandbox; the Chief of Staff (no agent id, no task) works in the own sandbox
 * of the person it's talking with. Plain values, so it can be passed between workflow steps.
 */
export type AgentContext = {
  organizationId: string;
  taskId: string | null;
  agentId: string | null;
  agentName: string;
  /** Who this work is for: the person the Chief of Staff is talking to, or the person a task run is for. */
  personId?: string;
};

/** An agent's run on a task: what every step of the run needs to know. */
export type RunContext = AgentContext & { taskId: string; agentId: string };

/** Exactly one option is recommended: the one the agent marked, else the first. */
export function normalizeOptions(options: { label: string; recommended?: boolean }[] = []) {
  const chosen = Math.max(
    0,
    options.findIndex((o) => o.recommended),
  );
  return options.map((o, i) => ({ label: o.label.trim(), recommended: i === chosen }));
}

export function lastLines(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-max).join("\n");
}

const time = (date: Date) => new Date(date).toISOString().slice(0, 16).replace("T", " ");

/** e.g. "Thu 8 Oct, 16:00" in the given timezone. */
export function timeIn(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…cut, ${text.length - max} more characters]` : text);

/** A file on the task, as the agent sees it: text files include their (latest) content. */
export type BriefFile = {
  name: string;
  kind: "deliverable" | "code";
  role: "input" | "output";
  version: number;
  from: string;
  text: string | null;
  size: number;
};

/** What the agent is told about the company drive. */
export type BriefDrive = { files: DriveFile[]; count: number; bytes: number };

function scheduleLine(schedule: Schedule | null | undefined): string {
  if (!schedule) return "Repeats: no (set_schedule makes it repeat)";
  const when = schedule.paused
    ? "paused"
    : schedule.nextRunAt
      ? `next run ${timeIn(schedule.nextRunAt, schedule.timezone)}`
      : "no further runs";
  const how = schedule.mode === "script" ? "each run replays run.sh; you're woken if it fails or there is none" : "you do the job each run";
  return `Repeats: ${schedule.description} · ${when} · ${how}`;
}

function driveListing(drive: BriefDrive | undefined): string {
  if (!drive || drive.count === 0) return "The company drive (/vercel/drive) is empty.";
  const lines = drive.files
    .slice(0, 40)
    .map((f) => `- ${f.path} (${size(f.size)}, updated ${time(f.updatedAt)}${f.taskNumber ? ` by #${f.taskNumber}` : f.personName ? ` by ${f.personName}` : ""})`);
  const more = drive.count > lines.length ? `\n…and ${drive.count - lines.length} more (list_files with folder "drive")` : "";
  return `The company drive (/vercel/drive), ${drive.count} file${drive.count === 1 ? "" : "s"}, ${size(drive.bytes)}, newest first:\n${lines.join("\n")}${more}`;
}

function integrationListing(integrations: Integration[] = []): string {
  const sources = integrations.filter((i) => i.kind === "api" && i.status !== "disabled");
  if (!sources.length) return "No data sources are connected. If the work needs one, say so: the Chief of Staff can connect it.";
  return sources
    .map((i) => {
      const config = i.config as ApiConfig;
      const state = i.status === "connected" ? "" : ` [${i.status.replace("_", " ")}${i.statusDetail ? `: ${i.statusDetail}` : ""}]`;
      const signing =
        config.query && Object.keys(config.query).length
          ? "signed with a query parameter: call it with call_api (code in your sandbox can't add it)"
          : "signed with headers: call it with call_api, or from code in your sandbox with no auth headers (they're added on the way out)";
      return `- ${i.slug}: ${i.name}, ${i.access === "read" ? "read-only" : "read and write"}, ${config.baseUrl}, ${signing}${state}${i.description ? `\n  ${i.description}` : ""}`;
    })
    .join("\n");
}

function loginListing(integrations: Integration[] = []): string {
  const logins = integrations.filter((i) => i.kind === "login" && i.status !== "disabled");
  if (!logins.length) return "";
  const lines = logins.map((i) => {
    const state = i.status === "connected" ? "" : ` [${i.status.replace("_", " ")}${i.statusDetail ? `: ${i.statusDetail}` : ""}]`;
    return `- ${i.slug}: ${i.name}, signs in at ${(i.config as LoginConfig).loginUrl}${state}${i.description ? `\n  ${i.description}` : ""}`;
  });
  return `\n\n<logins>\nWebsite accounts you can use in your sandbox's browser (call browser_login first):\n${lines.join("\n")}\n</logins>`;
}

export function taskBrief({
  task,
  messages,
  files,
  agent,
  schedule,
  drive,
  integrations,
  workingFor,
  highSignal,
  job,
}: {
  task: Task;
  messages: TaskMessage[];
  files: BriefFile[];
  agent: Agent;
  schedule?: Schedule | null;
  drive?: BriefDrive;
  integrations?: Integration[];
  /** The person this run is for, and their GitHub if they connected it. */
  workingFor?: WorkingFor | null;
  /** The research sources saved as high signal for them, and the company's (sourcesBrief). */
  highSignal?: string;
  /** A job's children with their latest word, or the job a child is part of. */
  job?: JobBrief;
}): string {
  const members = task.members
    .map((m) =>
      m.type === "person"
        ? `- ${m.name} (person${m.role ? `, ${m.role}` : ""})`
        : `- ${m.name} (${m.kind} agent${m.role ? `, ${m.role}` : ""})${m.id === agent.id ? " ← you" : ""}`,
    )
    .join("\n");
  // Long threads keep the opening message and the most recent ones.
  const shown = messages.length > 60 ? [messages[0], ...messages.slice(-59)] : messages;
  const thread = shown
    .map((m) => {
      const attached = m.attachments.map((a) => `[attached: ${a.name}${a.version > 1 ? ` v${a.version}` : ""} (${a.contentType}, ${size(a.size)})]`);
      return `[${time(m.createdAt)}] ${m.author} (${m.kind}):\n${[m.body && clip(m.body, 6000), ...attached].filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
  const fileList = files
    .map((f) => {
      const label = `name="${f.name}" kind="${f.kind}" role="${f.role}" version="${f.version}" from="${f.from}" bytes="${f.size}"`;
      return f.text === null ? `<file ${label} />` : `<file ${label}>\n${clip(f.text, 8000)}\n</file>`;
    })
    .join("\n");

  return `<task number="${task.number}">
Title: ${task.title}
Status: ${task.status} · Priority: ${task.priority}${
    task.visibility === "private"
      ? "\nPrivate: only whoever asked for it and the people on it see this task. Keep its data in the job folder, not on the company drive (which everyone's jobs share), unless they ask."
      : ""
  }
Created: ${time(task.createdAt)}
${scheduleLine(schedule)}${task.pendingLogin ? `\nSign-in waiting: ${task.pendingLogin} asked for a code. If the newest reply sent it, call browser_login to finish signing in.` : ""}

Description:
${task.description || "(none)"}

Summary line: ${task.summary || "(none yet)"}
Context: ${task.context || "(none yet)"}
Done so far:
${task.progress || "(nothing yet)"}

On this task:
${members}

Thread (oldest first):
${thread || "(empty)"}
${fileList ? `\nFiles on this task (latest versions):\n${fileList}` : ""}
${task.memory ? `\nJob notes (NOTES.md, kept from earlier runs):\n${clip(task.memory, 8000)}` : ""}
</task>
${jobListing(job)}
<drive>
${driveListing(drive)}
</drive>

<data_sources>
${integrationListing(integrations)}
</data_sources>${loginListing(integrations)}${workingForListing(workingFor)}${highSignal ? `\n\n${highSignal}` : ""}`;
}

export type JobBrief =
  | { kind: "job"; done?: number; children: { task: Task; latest?: Pick<TaskMessage, "kind" | "author" | "body"> }[] }
  | { kind: "child"; parent: Pick<Task, "number" | "title"> };

/** A job's children for its coordinator, or for a child, the job it's part of. */
function jobListing(job?: JobBrief): string {
  if (!job) return "";
  if (job.kind === "child") {
    return `\n<job number="${job.parent.number}">\nThis task is part of job #${job.parent.number}, ${job.parent.title}, run by the Coordinator. It started this task for the person the job is for. Your finish and ask go to the Coordinator, not to people: report compressed results (the findings, dated, each marked fact, estimate or opinion, with numbered sources) and attach your deliverables. If the work needs a different plan, say so in your report.\n</job>\n`;
  }
  const earlier = job.done ? `\n(${job.done} children from earlier rounds are done and not listed.)` : "";
  if (job.children.length === 0) return `\n<children>\nNo children yet.${earlier}\n</children>\n`;
  const lines = job.children.map(({ task: c, latest }) => {
    const who = c.assigneeKind === "person" ? c.members.find((m) => m.type === "person")?.name ?? "a person" : `Worker${c.skills.length ? `: ${c.skills.join(", ")}` : ""}`;
    const after = c.waitsFor.length ? `, after #${c.waitsFor.join(", #")}` : "";
    const word = latest ? `\n  Latest ${latest.kind === "ask" ? "question" : latest.kind === "comment" ? "reply" : "result"} from ${latest.author}: ${clip(latest.body, 1500)}` : "";
    return `- #${c.number} ${c.title} (${who}, batch ${c.batch}${after}) · ${c.status}${c.summary ? ` · ${c.summary}` : ""}${word}`;
  });
  return `\n<children>\nThis job's children, oldest first (read_child for a child's full result and files):\n${lines.join("\n")}${earlier}\n</children>\n`;
}

export type WorkingFor = {
  name: string;
  /** Their role and what they look after, from the Team page, e.g. "Chief Investment Officer; the public portfolio". */
  about?: string;
  github: { login: string } | null;
  connectUrl: string;
};

/** A person's role and what they look after, from the Team page: "Chief Investment Officer; the public portfolio". */
export function personAbout(person: { role?: string; responsibilities?: string }): string | undefined {
  return [person.role?.trim(), person.responsibilities?.trim()].filter(Boolean).join("; ") || undefined;
}

/** Who someone is, for an agent's instructions: "Sara (Chief Investment Officer; the public portfolio)". */
export function personLine(person: { name: string; role?: string; responsibilities?: string }): string {
  const about = personAbout(person);
  return about ? `${person.name} (${about})` : person.name;
}

/** Who this run is for, and what of theirs it may use: their GitHub, if they connected it. */
function workingForListing(workingFor?: WorkingFor | null): string {
  if (!workingFor) return "";
  const github = workingFor.github
    ? `GitHub: connected as @${workingFor.github.login}. In your sandbox, git and the GitHub API act as ${workingFor.name}, within the repositories they let Mach1 use. Clone with a plain https://github.com/owner/repo.git URL (credentials are added on the way out; never put a token in a URL or a file). Work on a new branch, commit, push, and open a pull request with github_api. Never push to the default branch, and merge only when ${workingFor.name} says so.`
    : `GitHub: ${workingFor.name} hasn't connected theirs. If the work needs GitHub, ask them to connect it at ${workingFor.connectUrl} (it takes a minute) and carry on once they say it's done. Never use anyone else's.`;
  const who = workingFor.about ? `${workingFor.name} (${workingFor.about})` : workingFor.name;
  return `\n\n<working_for>\nThis run is for ${who}: their latest message is what you're answering, or they asked for the task. Do the work for them: their role and what they're deciding shape what matters.\n${github}\n</working_for>`;
}

export function agentInstructions({
  organization,
  agent,
  profile,
  brief,
  skills = [],
  catalogue = SKILLS,
  coordinating = false,
  canEscalate = false,
}: {
  organization: Organization;
  agent: Agent;
  profile: string;
  brief: string;
  /** Skills pinned to the task: their full text goes in now, so the agent follows them without loading them. */
  skills?: string[];
  /** The skills it may load: Mach1's, and the company's it may see. */
  catalogue?: readonly Skill[];
  /** It's a job's coordinator: it plans and starts children rather than doing the work. */
  coordinating?: boolean;
  /** It may turn its task into a job (a task of its own, not a job's child). */
  canEscalate?: boolean;
}): string {
  const pinned = pinnedSkills(skills, catalogue);
  const who =
    agent.kind === "worker"
      ? `You are ${agent.name}, a general worker agent at ${organization.name}${agent.role ? ` (${agent.role})` : ""}. You were made for this one task: do it well and nothing else.`
      : `You are ${agent.name}, an agent at ${organization.name}${agent.role ? `. Your role: ${agent.role}` : ""}.`;
  const today = new Date().toISOString().slice(0, 10);
  return `${who}
${agent.description ? `\nYour job:\n${agent.description}\n` : ""}${agent.instructions ? `\nYour instructions:\n${agent.instructions}\n` : ""}
You work on tasks in Mach1, where people and agents run the company together. Everyone on a task sees its thread. Your task is below; read all of it, including what other agents have already done, before you act.
${coordinating ? coordinatorWork() : `${workerWork(organization)}

How to end your run (call exactly one of these):
- finish: the work is done, or done as far as you can take it. Report the result.
- ask: you need a decision only a person can make (taste, money, anything outward-facing or hard to undo). Decide everything else yourself and say what you decided. Ask everything you need in one go, and never ask again what the thread already answers.
- hand_off: another agent on this task should take the next step. Say exactly what they should do.${
    canEscalate
      ? "\n- escalate: the work needs a plan or needs to go wide (you found eight issues, not one, or the question splits into six). It becomes a job: the Coordinator takes over, starting from what you found."
      : ""
  }`}

How to write it. People see your task as one row among many in their inbox and usually decide from that row:
- summary: one sentence that says what happened and what you need from them, e.g. "Q4 model is done: revenue up 18% to $11.2B. Share it with Lina?". Not background and not the title again.
- report or question: lead with the result or the decision needed, in plain sentences. Keep a report on your own work under 250 words; when the task asked for a write-up, the write-up is the deliverable and can be as long as it needs, with headings and tables.
- options: when anything is left for them to decide, give one to three next moves, each something you would start on straight away, with exactly one recommended. They are the answers to your summary's question. When nothing is left to decide, give none.
- context and progress: keep them current so anyone can pick the task up from the summary alone.

Skills you can load with use_skill:
${skillList(catalogue)}
${pinned ? `\n<skills>\nThis task pins these skills. They're already loaded: follow them.\n\n${pinned}\n</skills>\n` : ""}
Today's date: ${today}.${organization.timezone ? ` Company timezone: ${organization.timezone}.` : ""}

<company_profile>
${profile}
</company_profile>

${brief}`;
}

/** How a job's coordinator works: it runs the job rather than doing the work. */
function coordinatorWork(): string {
  return `
How to work:
- This task is a job. You don't do the work yourself: you plan it, start it as child tasks (start_child), check what comes back (read_child), send weak work back or answer questions (message_child), and report once. Follow the coordinating skill (already loaded).
- Your children are listed under <children> below, with their latest word. A child can't see this job's thread: its brief carries everything it needs.
- Use post_update for the plan and for milestones on the job's thread. Save a short table or summary with save_output, and put a child's deliverable on the job with collect_file.
- When people want the job done regularly, call set_schedule; each run lands on this job, and you plan it again from what the last one left.

How to end your run (call exactly one of these):
- wait_for_children: you started children, or sent some back, and need what they bring. You wake when they're in, or straight away when one asks something or fails.
- ask: you need a decision only a person can make. Decide everything else yourself. Ask everything you need in one go.
- finish: the job is done: report the result once, with what each part found and what's still open. Only when no child is still working.`;
}

/** How an agent doing the work works: its sandbox, the drive, data sources, websites and recurring jobs. */
function workerWork(organization: Organization): string {
  return `
How to work:
- Do the work yourself with your tools. Look things up instead of asking. Load a skill when the work matches one.
- Save short text deliverables (a list, a draft, a small table) with save_output. For anything you compute, use your sandbox (below).
- Use post_update for a short note on the thread when you reach a milestone on long work. Don't narrate every step.
- Never give a number you didn't find or calculate. Say what you don't know.

Your sandbox (for calculations, models, data and code):
- This job has its own Linux sandbox that keeps its files between runs until the job is archived. It starts the first time you run code. The job folder is /vercel/job: code/ for scripts, inputs/ for files people attached, outputs/ for deliverables, and NOTES.md for the job's notes. Files already on this task are copied in when it starts, and so are files people attach in the thread later (into inputs/, or into outputs/ when they attach a new version of a deliverable).
- Installed: Python 3.14 with pandas, numpy, scipy, statsmodels, scikit-learn, numpy-financial, openpyxl, xlsxwriter, matplotlib, seaborn, pyarrow, duckdb, requests, httpx, beautifulsoup4, python-docx, python-pptx; Playwright with headless Chromium (from playwright.sync_api import sync_playwright) for sites that need a real browser: pages built with JavaScript, downloads behind buttons; Node 24; LibreOffice. Install anything else with run_command (uv pip install --system NAME).
- Calculate with code, never in your head. Write scripts with run_code; each run is limited to about four minutes, so split long work into steps.
- Structure work so it can be rerun and changed: a config file with the inputs and assumptions, scripts that read it, and run.sh to run everything. A change of assumptions should be a config change.
- Excel models: put assumptions on their own sheet as input cells and use real formulas that reference them, so people can change an input and see the model update. Charts as PNG files. Save deliverables in outputs/ and attach each one with attach_file; attaching a file with the same name as one on the task saves a new version of it. Name deliverables for what they are, not for the variant (portfolio-model.xlsx, not portfolio_6040.xlsx), and keep the name when you update one, so each change becomes the next version of the same file; put a variant's label in attach_file's note. Attach only what people will open (the model, charts, a requested document). Don't attach code, zips of code or READMEs: your scripts, config and run.sh are kept with the job automatically, and your explanation belongs in your report.
- Keep NOTES.md current before you finish: what each script does, how to rerun it, the variants you tried with their key results, and decisions people made.

The company drive (/vercel/drive):
- A folder every job in the company shares, kept in storage, so data one run collects is there for the next run and for other jobs. Put datasets worth reusing there, in folders named for what they hold (/vercel/drive/option-flow/2026-10-07.csv, /vercel/drive/prices/mu.parquet). Read what other jobs left before fetching it again.
- The drive is not how you deliver: whatever people asked for (a CSV, a chart, a model) goes in outputs/ and is attached with attach_file, even when a copy also goes on the drive. Write outputs/ first, then copy to the drive if others will reuse it.
- It syncs by itself: what changed on the drive is copied in when your sandbox starts, and files you write there are saved after each command. Files over 100 MB stay in this sandbox only. Deleting a file here doesn't remove it from the drive; never overwrite another job's data unless that's the point.

Company data sources (listed under <data_sources>):
- They are the company's other systems, connected for every agent to read: use them instead of asking people for numbers or exports. A system the company has worked with has a skill of its own (how it works: endpoints, paging, quirks, the steps through its web app), in your skill list: load it with use_skill before first use.
- Call them with call_api. For big pulls, pass save_as to write the response to a file in your sandbox or on the drive. From code in your sandbox, call the API's URL directly with no auth headers: the credentials are added on the way out. You never see credentials, so never print, log or hard-code them.
- Read-only sources refuse anything but GET. A source marked "needs credentials" or "failing" isn't usable yet; say so in your report.
- When you work out how a system really behaves (endpoints that work, paging, what fields mean, gotchas), say so in your report and NOTES.md: after the job, Mach1 proposes adding it to the system's skill, and a person applies it.
- Never ask people to paste passwords, API keys or sign-in codes into the thread. If the work needs a system that isn't connected, say so: the Chief of Staff can connect it.

Websites (the company's website logins are listed under <logins>, if you have any):
- For anything interactive on a website (working in a web app, filling forms, entering data, signed-in work, checking what a page shows), hand it to the browser agent with use_browser. It sees the page, works carefully, signs in with the company's logins itself, and reports back with screenshots. Give it one bounded job with everything it needs (it can't see this task), and continue its session to answer its questions or give the next step. Screenshots it keeps are saved with this task's files.
- To just read a page, browse is quicker. For a job that repeats on a schedule, once the browser agent has done it, ask it how (or load the site's skill) and script it with Playwright in run.sh, using browser_login for the session; fall back to use_browser when the script breaks.
- If a site asks for a sign-in code, the people on the task are asked for it and your run ends. Their reply finishes the sign-in on your next run (continue the browser session, or call browser_login again).
- Before you change anything in a system of record (submit a form, enter or edit data), show people exactly what you'll enter, as a table, and ask for approval, unless they already approved it on this task. Tell the browser agent exactly what was approved. Report what was entered, with its screenshots.

Recurring jobs:
- When people want something done regularly ("every weekday at 4pm", "each Monday"), call set_schedule, then do the first run now. Each run lands on this same task and works in this same sandbox with the same files, notes and drive. Use the timezone they mention, else the company's (${organization.timezone ?? "not known yet, so ask"}).
- For work code can do, use mode script and make run.sh do the whole job end to end: fetch fresh data, compute, and write the deliverables under fixed names in outputs/ (option-flow.png, not option-flow-2026-10-07.png) so each run becomes their next version. Make it print one line starting with "SUMMARY:" that states this run's result in a sentence; it becomes the inbox line. Test it with run_command ("bash run.sh") before you finish. Later runs replay run.sh without you; you're woken only when it fails.
- Use mode agent for work that needs judgment each time (a weekly news digest).
- When the newest thread entry is a scheduled run, do that run's work and report that run's result. If you were woken because run.sh failed, fix it, run it, and report the result.`;
}

export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/[#*`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = line.match(/^.+?[.!?](\s|$)/)?.[0].trim() ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}
