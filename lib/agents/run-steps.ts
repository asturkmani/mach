import { getAgent } from "@/lib/agents/store";
import { driveStats, listDrive } from "@/lib/drive";
import { listIntegrations } from "@/lib/integrations";
import { contentTypeFor, isText, listTaskFiles, readVersion, saveVersion } from "@/lib/files";
import {
  agentInstructions,
  firstSentence,
  lastLines,
  MAX_AGENT_TURNS,
  normalizeOptions,
  taskBrief,
  timeIn,
  type BriefDrive,
  type BriefFile,
  type RunContext,
  type RunOutcome,
} from "@/lib/agents/prompts";
import { getOrganization } from "@/lib/orgs";
import { loadProfile } from "@/lib/profile/store";
import { deleteSchedule, getSchedule, saveSchedule, scheduleProblem, type ScheduleMode } from "@/lib/schedules";
import { recordMentions } from "@/lib/task-mentions";
import {
  addMessage,
  agentsOn,
  claimRun,
  countPersonComments,
  getTask,
  listMessages,
  releaseRun,
  renewRun,
  updateTask,
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
    };

export type BriefImage = { name: string; mediaType: string; data: string };

/** Checks the run can go ahead, takes the task's lease and gathers everything the agent will read. */
export async function beginRun(
  organizationId: string,
  taskId: string,
  agentId: string,
  { modelGiven = false }: { modelGiven?: boolean } = {},
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

  if (task.agentTurns >= MAX_AGENT_TURNS) {
    await updateTask(organizationId, task.id, {
      status: "waiting",
      summary: `Agents have taken ${task.agentTurns} turns in a row without a person. Check the thread and say how to go on.`,
      options: [],
    });
    return skip("Too many agent turns in a row.");
  }

  const context: RunContext = { organizationId, taskId: task.id, agentId: agent.id, agentName: agent.name };
  const model = process.env.AGENT_MODEL || process.env.CHIEF_OF_STAFF_MODEL || "";
  if (!model && !modelGiven) {
    await failRun(context, "Set AGENT_MODEL or CHIEF_OF_STAFF_MODEL to an AI Gateway model id (see README).");
    return { ok: false, outcome: { type: "failed", error: "No model configured." } };
  }
  if (!(await claimRun(organizationId, task.id, agent.id))) return { ok: false, outcome: { type: "busy" } };

  const [profile, messages, files, schedule, drive, integrations] = await Promise.all([
    loadProfile(organizationId),
    listMessages(task.id),
    briefFiles(organizationId, task.id),
    getSchedule(task.id),
    briefDrive(organizationId),
    listIntegrations(organizationId, { agentId: agent.id }),
  ]);
  const others = agentsOn(task).filter((m) => m.id !== agent.id);
  const images = await newImages(organizationId, messages, agent.id);
  return {
    ok: true,
    context,
    model,
    instructions: agentInstructions({ organization, agent, profile, brief: taskBrief({ task, messages, files, agent, schedule, drive, integrations }) }),
    prompt: `Work on task #${task.number} now. End with finish, ask${others.length ? " or hand_off" : ""}.`,
    otherAgents: others.map((a) => ({ id: a.id, name: a.name })),
    sources: integrations.filter((i) => i.kind === "api" && i.status !== "disabled").map((i) => i.slug),
    logins: integrations.filter((i) => i.kind === "login" && i.status !== "disabled").map((i) => i.slug),
    images,
  };
}

const MAX_IMAGES = 4;
const MODEL_IMAGE_EDGE = 1568;

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
    .filter((a) => /^image\/(png|jpeg|gif|webp)$/.test(a.contentType))
    .slice(-MAX_IMAGES);
  if (attached.length === 0) return [];
  const { default: sharp } = await import("sharp");
  const images: BriefImage[] = [];
  for (const a of attached) {
    const file = await readVersion(organizationId, a.versionId);
    if (!file) continue;
    try {
      const scaled = await sharp(file.bytes)
        .rotate()
        .resize({ width: MODEL_IMAGE_EDGE, height: MODEL_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      images.push({ name: a.name, mediaType: "image/jpeg", data: scaled.toString("base64") });
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

export async function keepLease(context: RunContext): Promise<void> {
  "use step";
  await renewRun(context.taskId, context.agentId);
}

export async function endRun(context: RunContext): Promise<void> {
  "use step";
  await releaseRun(context.taskId, context.agentId);
}

export async function personCommentCount(taskId: string): Promise<number> {
  "use step";
  return countPersonComments(taskId);
}
