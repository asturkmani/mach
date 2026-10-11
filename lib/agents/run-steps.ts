import { knownSkills, SKILLS, toolsOf, type Skill } from "@/lib/agents/skills";
import { companySkillsFor } from "@/lib/company-skills";
import { agentModel, builtinSkills, COORDINATOR_AGENT, getAgent } from "@/lib/agents/store";
import { driveStats, listDrive } from "@/lib/drive";
import { allowedFor, listIntegrations } from "@/lib/integrations";
import { contentTypeFor, isText, listTaskFiles, readVersion, saveVersion } from "@/lib/files";
import {
  agentInstructions,
  firstSentence,
  lastLines,
  MAX_AGENT_TURNS,
  MAX_COORDINATOR_TURNS,
  normalizeOptions,
  personAbout,
  taskBrief,
  timeIn,
  type BriefDrive,
  type BriefFile,
  type JobBrief,
  type RunContext,
  type RunOutcome,
} from "@/lib/agents/prompts";
import { appUrl } from "@/lib/app-url";
import { getGitHubConnection } from "@/lib/github";
import { getOrganization } from "@/lib/orgs";
import { getPerson } from "@/lib/people";
import { loadProfile } from "@/lib/profile/store";
import { listSources } from "@/lib/research/store";
import { sourcesBrief } from "@/lib/research/sources";
import { deleteSchedule, getSchedule, saveSchedule, scheduleProblem, type ScheduleMode } from "@/lib/schedules";
import { recordMentions } from "@/lib/task-mentions";
import { imageForModel, MODEL_IMAGE_TYPES } from "@/lib/agents/images";
import {
  addMessage,
  agentsOn,
  agentToWake,
  claimRun,
  QUEUED,
  countPersonComments,
  getTask,
  listChildren,
  listMessages,
  reactToMessages,
  releaseRun,
  renewRun,
  updateTask,
  type Task,
  type TaskMessage,
  type TaskOption,
} from "@/lib/tasks";

// The durable steps of an agent run. Each one does a little database work and
// returns plain values. Inside the agent-run workflow every call is its own
// step, retried on failure and recorded; called anywhere else (tests), the
// "use step" directive does nothing and they run as ordinary functions.

export type BegunRun =
  | { ok: false; outcome: RunOutcome }
  | {
      ok: true;
      context: RunContext;
      model: string;
      instructions: string;
      prompt: string;
      /** The other agents on the task, which this one can hand off to. */
      otherAgents: { id: string; name: string }[];
      /** The data sources this agent may call (slugs). */
      sources: string[];
      /** The website logins this agent may use (slugs). */
      logins: string[];
      /** Images people attached since this agent last spoke, sized for the model. */
      images: BriefImage[];
      /** The people's messages this run answers: they get its reaction (👀, then how it ended). */
      answering: string[];
      /** The skills pinned to the task (or implied by an older built-in agent), already in its instructions. */
      skills: string[];
      /** The tools those skills switch on (e.g. exa_search). */
      skillTools: string[];
      /** The company's skills this run may load, besides Mach1's. */
      companySkills: Skill[];
      /** The research sources saved as high signal for whoever it works for, and the company's, for its prompts. */
      highSignal: string;
      /** It's a job's coordinator: it gets the job's tools instead of the work's. */
      coordinating: boolean;
      /** It may turn its task into a job (not a job's child, not the coordinator). */
      canEscalate: boolean;
    };

export type BriefImage = { name: string; mediaType: string; data: string };

/** Checks the run can go ahead, takes the task's lease and gathers everything the agent will read. */
export async function beginRun(
  organizationId: string,
  taskId: string,
  agentId: string,
): Promise<BegunRun> {
  "use step";
  const [organization, task, agent] = await Promise.all([
    getOrganization(organizationId),
    getTask(organizationId, taskId),
    getAgent(organizationId, agentId),
  ]);
  const skip = (reason: string): BegunRun => ({ ok: false, outcome: { type: "skipped", reason } });
  if (!organization || !task || !agent) return skip("Task or agent not found.");
  if (!agentsOn(task).some((m) => m.id === agent.id)) return skip(`${agent.name} isn't on this task.`);
  if (agent.status !== "active") return skip(`${agent.name} is ${agent.status}.`);
  if (task.status === "done" || task.status === "cancelled") return skip("The task is closed.");

  const coordinating = agent.builtin === COORDINATOR_AGENT;
  if (task.agentTurns >= (coordinating ? MAX_COORDINATOR_TURNS : MAX_AGENT_TURNS)) {
    await updateTask(organizationId, task.id, {
      status: "waiting",
      summary: `Agents have taken ${task.agentTurns} turns in a row without a person. Check the thread and say how to go on.`,
      options: [],
    });
    return skip("Too many agent turns in a row.");
  }

  const context: RunContext = { organizationId, taskId: task.id, agentId: agent.id, agentName: agent.name };
  if (!(await claimRun(organizationId, task.id, agent.id))) return { ok: false, outcome: { type: "busy" } };

  const [profile, messages, files, schedule, drive, integrations, job] = await Promise.all([
    loadProfile(organizationId),
    listMessages(task.id),
    briefFiles(organizationId, task.id),
    getSchedule(task.id),
    briefDrive(organizationId),
    listIntegrations(organizationId),
    jobBrief(organizationId, task, coordinating),
  ]);
  const canEscalate = !coordinating && !task.parentTaskId && task.kind === "task";
  const others = agentsOn(task).filter((m) => m.id !== agent.id);
  const images = await newImages(organizationId, messages, agent.id);
  // The people's messages since this agent last wrote, and any still showing its 👀 or ⏳ (one
  // queued while it was working, or that a run never got to).
  const since = messages.findLastIndex((m) => m.agentId === agent.id);
  const answering = messages
    .filter(
      (m, i) =>
        m.personId &&
        m.kind === "comment" &&
        (i > since || m.reactions.some((r) => r.agentId === agent.id && (r.emoji === "👀" || r.emoji === QUEUED))),
    )
    .map((m) => m.id);
  await reactToMessages(agent.id, answering, "👀");
  // Who this run is for: what of theirs it may use (their GitHub) follows from it.
  const forId = workingForId(task, messages, answering);
  const [forPerson, github, sources, companySkills] = await Promise.all([
    forId ? getPerson(organizationId, forId) : null,
    forId ? getGitHubConnection(organizationId, forId) : null,
    listSources(organizationId, { viewer: forId }),
    // The company's skills this run may load: the company's, and those of the person it works for.
    companySkillsFor(organizationId, forId),
  ]);
  const catalogue = [...SKILLS, ...companySkills];
  const skills = knownSkills([...builtinSkills(agent), ...task.skills], catalogue);
  // A model set on the task was chosen for its work, not for a coordinator planning it.
  const model = (agent.builtin !== COORDINATOR_AGENT && task.model) || agentModel(agent, organization.models, skills, catalogue);
  if (forPerson) context.personId = forPerson.id;
  // Only the integrations the person it works for may use (and this agent).
  const usable = integrations.filter((i) => allowedFor(i, forPerson?.id));
  const workingFor = forPerson && {
    name: forPerson.name,
    about: personAbout(forPerson),
    github: github?.status === "connected" ? { login: github.login } : null,
    connectUrl: appUrl("/connect/github"),
  };
  // Work on code or on connecting a system doesn't research; every other piece of work may.
  const highSignal = skills.some((s) => s === "coding-in-github" || s === "connecting-integrations") ? "" : sourcesBrief(sources, forPerson?.name);
  return {
    ok: true,
    context,
    model,
    instructions: agentInstructions({
      organization,
      agent,
      profile,
      skills,
      catalogue,
      coordinating,
      canEscalate,
      brief: taskBrief({ task, messages, files, agent, schedule, drive, integrations: usable, workingFor, highSignal, job }),
    }),
    prompt: coordinating
      ? `Run job #${task.number} now. End with wait_for_children, ask or finish.`
      : `Work on task #${task.number} now. End with finish, ask${others.length ? ", hand_off" : ""}${canEscalate ? " or escalate" : ""}.`,
    otherAgents: others.map((a) => ({ id: a.id, name: a.name })),
    sources: usable.filter((i) => i.kind === "api" && i.status !== "disabled").map((i) => i.slug),
    logins: usable.filter((i) => i.kind === "login" && i.status !== "disabled").map((i) => i.slug),
    images,
    answering,
    skills,
    skillTools: toolsOf(skills, catalogue),
    companySkills,
    highSignal,
    coordinating,
    canEscalate,
  };
}

/** For a job, its children with their latest word; for a child, the job it's part of. */
async function jobBrief(organizationId: string, task: Task, coordinating: boolean): Promise<JobBrief | undefined> {
  if (task.parentTaskId) {
    const parent = await getTask(organizationId, task.parentTaskId);
    return parent ? { kind: "child", parent: { number: parent.number, title: parent.title } } : undefined;
  }
  const all = await listChildren(organizationId, task.id);
  if (all.length === 0 && !coordinating) return undefined;
  // Children done in earlier rounds (a repeating job's past runs) are counted, not listed.
  const children = all.filter((c) => c.status !== "done");
  return {
    kind: "job",
    done: all.length - children.length,
    children: await Promise.all(
      children.map(async (child) => ({
        task: child,
        latest: (await listMessages(child.id)).findLast((m) => m.kind === "result" || m.kind === "ask" || (m.kind === "comment" && !!m.personId)),
      })),
    ),
  };
}

/**
 * The person a run works for: whoever wrote the newest message it answers,
 * else the last person to comment, else whoever asked for the task. Their own
 * accounts (GitHub) are what the run may use; never anyone else's.
 */
export function workingForId(
  task: Pick<Task, "createdByPersonId">,
  messages: Pick<TaskMessage, "id" | "personId" | "kind">[],
  answering: string[],
): string | null {
  const answered = messages.filter((m) => answering.includes(m.id) && m.personId);
  const commented = messages.filter((m) => m.personId && m.kind === "comment");
  return answered.at(-1)?.personId ?? commented.at(-1)?.personId ?? task.createdByPersonId ?? null;
}

const MAX_IMAGES = 4;
/**
 * The images people attached in the thread since this agent last wrote there
 * (newest first, at most four), so it sees what they showed it. Each is scaled
 * down to what the model reads anyway, which keeps the run's record small.
 */
async function newImages(organizationId: string, messages: TaskMessage[], agentId: string): Promise<BriefImage[]> {
  const since = messages.findLastIndex((m) => m.agentId === agentId);
  const attached = messages
    .slice(since + 1)
    .filter((m) => !m.agentId)
    .flatMap((m) => m.attachments)
    .filter((a) => MODEL_IMAGE_TYPES.test(a.contentType))
    .slice(-MAX_IMAGES);
  if (attached.length === 0) return [];
  const images: BriefImage[] = [];
  for (const a of attached) {
    const file = await readVersion(organizationId, a.versionId);
    if (!file) continue;
    try {
      images.push({ name: a.name, ...(await imageForModel(file.bytes)) });
    } catch (error) {
      console.error(`Couldn't read the image ${a.name}`, error);
    }
  }
  return images;
}

/** The job's files as the agent sees them; small text files include their content. */
async function briefFiles(organizationId: string, taskId: string): Promise<BriefFile[]> {
  const files = await listTaskFiles(organizationId, taskId);
  return Promise.all(
    files
      .filter((f) => f.versions.length > 0)
      .map(async (f) => {
        const latest = f.versions[0];
        const textual = isText(latest.contentType || contentTypeFor(f.name)) && latest.size <= 100_000;
        const content = textual ? await readVersion(organizationId, latest.id) : null;
        return {
          name: f.name,
          kind: f.kind,
          role: f.role,
          version: latest.version,
          from: latest.taskId === taskId ? "this task" : latest.taskNumber ? `task #${latest.taskNumber}` : "the library",
          text: content ? content.bytes.toString("utf8") : null,
          size: latest.size,
        };
      }),
  );
}

async function briefDrive(organizationId: string): Promise<BriefDrive> {
  const [files, stats] = await Promise.all([listDrive(organizationId, { limit: 40 }), driveStats(organizationId)]);
  return { files, ...stats };
}

const by = (context: RunContext) => ({ author: context.agentName, agentId: context.agentId });

/** People an agent @-mentions are added to the task and see it in their Needs you. */
async function mentionPeople(context: RunContext, text: string): Promise<void> {
  if (!text.includes("@")) return;
  const task = await getTask(context.organizationId, context.taskId);
  if (task) await recordMentions(context.organizationId, task, text, { name: context.agentName, agentId: context.agentId });
}

export async function scheduleJob(
  context: RunContext,
  input: { cron: string; timezone: string; mode: ScheduleMode },
): Promise<string> {
  "use step";
  const problem = scheduleProblem(input.cron, input.timezone);
  if (problem) return `Not scheduled: ${problem}`;
  const schedule = await saveSchedule(context.taskId, { ...input, by: { agentId: context.agentId } });
  await addMessage(context.taskId, { ...by(context), kind: "event", body: `Set this job to repeat: ${schedule.description}.` });
  const next = schedule.nextRunAt ? timeIn(schedule.nextRunAt, schedule.timezone) : "never";
  return `Scheduled: ${schedule.description}. Next run ${next}.${
    input.mode === "script" ? " Make sure run.sh does the whole job and prints a SUMMARY: line." : ""
  }`;
}

export async function unscheduleJob(context: RunContext): Promise<string> {
  "use step";
  if (!(await deleteSchedule(context.taskId))) return "This job doesn't repeat.";
  await addMessage(context.taskId, { ...by(context), kind: "event", body: "Stopped this job repeating." });
  return "Stopped.";
}

export async function postUpdate(context: RunContext, input: { message: string; progress?: string }): Promise<string> {
  "use step";
  await addMessage(context.taskId, { ...by(context), kind: "update", body: input.message });
  await mentionPeople(context, input.message);
  if (input.progress !== undefined) {
    await updateTask(context.organizationId, context.taskId, { progress: lastLines(input.progress, 6) });
  }
  return "Posted.";
}

export async function saveFile(context: RunContext, input: { filename: string; content: string }): Promise<string> {
  "use step";
  const saved = await saveVersion(context.organizationId, {
    name: input.filename,
    kind: "deliverable",
    bytes: Buffer.from(input.content),
    taskId: context.taskId,
    agentId: context.agentId,
  });
  return saved.unchanged ? `${input.filename} is unchanged.` : `Saved ${input.filename} (version ${saved.version}).`;
}

type Report = { summary: string; options?: TaskOption[]; context?: string; progress?: string };

async function report(context: RunContext, status: "waiting" | "review", kind: "ask" | "result", body: string, fields: Report) {
  await addMessage(context.taskId, { ...by(context), kind, body });
  await mentionPeople(context, body);
  await updateTask(context.organizationId, context.taskId, {
    status,
    summary: fields.summary,
    options: normalizeOptions(fields.options),
    context: fields.context,
    progress: lastLines(fields.progress, 6),
  });
}

export async function askPeople(context: RunContext, input: Report & { question: string }): Promise<string> {
  "use step";
  await report(context, "waiting", "ask", input.question, input);
  return "Asked. Your run ends here; their answer starts your next one.";
}

export async function finishWork(context: RunContext, input: Report & { report: string }): Promise<string> {
  "use step";
  await report(context, "review", "result", input.report, input);
  return "Reported. Your run ends here.";
}

export async function handOff(
  context: RunContext,
  input: { to: { id: string; name: string }; note: string; summary: string; progress?: string },
): Promise<string> {
  "use step";
  await addMessage(context.taskId, { ...by(context), kind: "update", body: `@${input.to.name} ${input.note}` });
  await updateTask(context.organizationId, context.taskId, { summary: input.summary, progress: lastLines(input.progress, 6) });
  return `Handed to ${input.to.name}.`;
}

/** The model stopped without finishing or asking: whatever it said becomes the result. */
export async function reportText(context: RunContext, text: string): Promise<RunOutcome> {
  "use step";
  const body = text.trim();
  await addMessage(context.taskId, { ...by(context), kind: "result", body: body || "I stopped without a result." });
  await updateTask(context.organizationId, context.taskId, {
    status: body ? "review" : "waiting",
    summary: body ? firstSentence(body) : `${context.agentName} stopped without reporting back. Try again?`,
    options: body ? [] : [{ label: "Try again", recommended: true }],
  });
  return body ? { type: "finished" } : { type: "failed", error: "No result." };
}

async function failRun(context: RunContext, message: string): Promise<void> {
  await addMessage(context.taskId, { ...by(context), kind: "event", body: `Run failed: ${message}` });
  await updateTask(context.organizationId, context.taskId, {
    status: "waiting",
    summary: `${context.agentName} couldn't finish: ${firstSentence(message, 90)}`,
    options: [{ label: "Try again", recommended: true }],
  });
}

/** Parks the task with the people on it, with Try again as the next move. */
export async function recordFailure(context: RunContext, message: string): Promise<RunOutcome> {
  "use step";
  await failRun(context, message);
  return { type: "failed", error: message };
}

/** Keeps the run's lease fresh and says what the agent is doing now, for the live status on the task. */
/** Renews the run's lease. True when a person pressed Send now, so the run stops here. */
export async function keepLease(context: RunContext, activity?: string): Promise<boolean> {
  "use step";
  return renewRun(context.taskId, context.agentId, activity);
}

/** How a run ended, as the reaction on the messages it answered. */
const ENDED: Partial<Record<RunOutcome["type"], string>> = { finished: "✅", asked: "💬", handed_off: "🤝", failed: "⚠️" };

export async function endRun(context: RunContext, answering: string[] = [], outcome?: RunOutcome): Promise<void> {
  "use step";
  const emoji = outcome && ENDED[outcome.type];
  if (emoji) await reactToMessages(context.agentId, answering, emoji);
  // Stopped by Send now: say so in the thread (the next run reads it), and leave the 👀 on what it was
  // answering, so the next run answers that too.
  if (outcome?.type === "interrupted") {
    await addMessage(context.taskId, {
      author: context.agentName,
      agentId: context.agentId,
      kind: "event",
      body: "stopped what it was doing to read the new message",
    });
  }
  await releaseRun(context.taskId, context.agentId);
}

/** Who picks up after a run stopped for a person's message: the agent that message is for. */
export async function agentForLatestMessage(organizationId: string, taskId: string): Promise<string | undefined> {
  "use step";
  const task = await getTask(organizationId, taskId);
  if (!task) return undefined;
  const messages = await listMessages(taskId);
  const latest = messages.findLast((m) => m.personId && m.kind === "comment");
  return agentToWake(task, messages, latest?.body ?? "");
}

export async function personCommentCount(taskId: string): Promise<number> {
  "use step";
  return countPersonComments(taskId);
}
