import { firstSentence, timeIn, type RunContext } from "@/lib/agents/prompts";
import type { ReplayResult } from "@/lib/agents/sandbox-steps";
import { listTaskFiles } from "@/lib/files";
import { getSchedule } from "@/lib/schedules";
import { addMessage, agentsOn, agentToWake, claimRun, getTask, isRunning, listMessages, resetAgentTurns, updateTask } from "@/lib/tasks";

// The durable steps of a scheduled run (or a person's "Run again"): decide
// whether to replay run.sh or wake the agent, then report on the same card.

/** What started the run: the job's schedule, or a person asking to run the script again. */
export type RunTrigger = { kind: "schedule"; dueAt: string } | { kind: "rerun"; by: string; personId?: string };

export type ScheduledPlan =
  | { type: "skip"; reason: string }
  | { type: "agent"; agentId: string }
  | { type: "replay"; context: RunContext; label: string };

const SCHEDULER = "Schedule";

/** "a, b, c and 4 more" */
const listed = (items: string[], max = 3) =>
  items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");

export async function beginScheduledRun(organizationId: string, taskId: string, trigger: RunTrigger): Promise<ScheduledPlan> {
  "use step";
  const task = await getTask(organizationId, taskId);
  if (!task || task.archivedAt || task.status === "cancelled" || task.kind !== "task") {
    return { type: "skip", reason: "The job is closed." };
  }
  const schedule = await getSchedule(taskId);
  const timezone = schedule?.timezone ?? "UTC";
  const label = trigger.kind === "schedule" ? `Scheduled run, ${timeIn(new Date(trigger.dueAt), timezone)}` : "Run again";
  const note = (body: string) =>
    addMessage(task.id, {
      author: trigger.kind === "rerun" ? trigger.by : SCHEDULER,
      personId: trigger.kind === "rerun" ? trigger.personId : undefined,
      kind: "event",
      body,
    });

  const agentId = agentToWake(task, await listMessages(task.id));
  const agent = agentsOn(task).find((a) => a.id === agentId);
  if (!agent) {
    await note(`Skipped: ${label.toLowerCase()} needs an agent on the job.`);
    return { type: "skip", reason: "No agent on the job." };
  }
  if (isRunning(task)) {
    await note(`Skipped: ${label.toLowerCase()} came while a run was still going.`);
    return { type: "skip", reason: "A run is going." };
  }

  const hasScript = (await listTaskFiles(organizationId, task.id)).some((f) => f.kind === "code" && f.name === "run.sh");
  const replay = hasScript && (trigger.kind === "rerun" || schedule?.mode !== "agent");
  await note(`${label}${replay ? ": replaying run.sh" : ""}.`);
  // A scheduled run is like a person asking again: it reopens a done job, and
  // agents may take their turns afresh.
  await resetAgentTurns(task.id);
  await updateTask(organizationId, task.id, { status: "ready", options: [], laterUntil: null });
  if (!replay) return { type: "agent", agentId: agent.id };
  if (!(await claimRun(organizationId, task.id, agent.id, "Running run.sh"))) {
    await note(`Skipped: ${label.toLowerCase()} came while a run was still going.`);
    return { type: "skip", reason: "A run is going." };
  }
  return { type: "replay", context: { organizationId, taskId: task.id, agentId: agent.id, agentName: agent.name }, label };
}

/** run.sh worked: report this run's result on the card, in the inbox. */
export async function reportReplay(context: RunContext, result: Extract<ReplayResult, { ok: true }>, label: string): Promise<void> {
  "use step";
  const updated = result.attached.length ? `Updated ${result.attached.join(", ")}.` : "No deliverables changed.";
  const lines = [
    `**${label}.** ${result.summary ?? "run.sh finished."}`,
    "",
    updated,
    result.unattached.length ? `Also wrote ${result.unattached.join(", ")} in outputs/ (not attached).` : "",
    result.drive.length ? `Saved to the drive: ${listed(result.drive)}.` : "",
  ];
  await addMessage(context.taskId, {
    author: context.agentName,
    agentId: context.agentId,
    kind: "result",
    body: lines.filter((l, i) => l || i === 1).join("\n").trim(),
  });
  await updateTask(context.organizationId, context.taskId, {
    status: "review",
    summary: result.summary ? firstSentence(result.summary) : `${label}: ${updated.toLowerCase()}`,
    options: [],
    laterUntil: null,
  });
}

/** run.sh failed or is missing: put the log on the thread and hand the run to the agent to fix. */
export async function replayToAgent(context: RunContext, result: Extract<ReplayResult, { ok: false }>, label: string): Promise<void> {
  "use step";
  const what = result.reason === "no_script" ? "run.sh is missing from the job folder" : "run.sh failed";
  await addMessage(context.taskId, {
    author: SCHEDULER,
    kind: "update",
    body: `${label}: ${what}. @${context.agentName}, fix it, run it and report this run's result.\n\n\`\`\`\n${result.log.slice(-3000)}\n\`\`\``,
  });
  await updateTask(context.organizationId, context.taskId, { status: "ready", options: [] });
}
