import "server-only";

import { start } from "workflow/api";

import { runAgentChain, type RunOptions } from "@/lib/agents/runner";
import { runScheduled, type RunTrigger } from "@/lib/agents/scheduled";
import {
  addMessage,
  agentsOn,
  claimJobWake,
  followersReady,
  getTask,
  inFlight,
  listChildren,
  needsAnswer,
  updateTask,
} from "@/lib/tasks";
import { reviewRoundStep, reviseProposalsStep } from "@/lib/learning/review-steps";
import { agentRunWorkflow } from "@/workflows/agent-run";
import { learningReviewWorkflow, proposalRevisionWorkflow } from "@/workflows/learning-review";
import { scheduledRunWorkflow } from "@/workflows/scheduled-run";

export { agentToWake } from "@/lib/tasks";

// Starts agent runs as durable workflows (Vercel Workflow), so they keep
// going after the request that started them and can run for as long as the
// work takes.

type Work = () => Promise<void>;

let inline: { schedule: (work: Work) => void; options: RunOptions } | null = null;

/** Tests run the work inline (or capture it) instead of starting a workflow. */
export function setScheduler(schedule: ((work: Work) => void) | null, options: RunOptions = {}): void {
  inline = schedule ? { schedule, options } : null;
}

export async function dispatchRun(organizationId: string, taskId: string, agentId: string): Promise<void> {
  if (inline) {
    const { options } = inline;
    inline.schedule(() => runAgentChain(organizationId, taskId, agentId, options));
    return;
  }
  await start(agentRunWorkflow, [organizationId, taskId, agentId]);
}

let reviews: ((work: Work) => void) | null = null;

/** Tests run reviews (which call models) only when they ask to: with a scheduler set, they're skipped otherwise. */
export function setReviewScheduler(schedule: ((work: Work) => void) | null): void {
  reviews = schedule;
}

/** Reviews a round of work that just closed, in the background (lib/learning/review.ts). */
export async function dispatchReview(organizationId: string, taskId: string): Promise<void> {
  if (inline || reviews) {
    reviews?.(async () => void (await reviewRoundStep(organizationId, taskId)));
    return;
  }
  await start(learningReviewWorkflow, [organizationId, taskId]);
}

/** Has the learner revise proposed changes from a person's words, in the background. */
export async function dispatchRevision(organizationId: string, messageTaskId: string, numbers: number[], words: string): Promise<void> {
  if (inline || reviews) {
    reviews?.(async () => void (await reviseProposalsStep(organizationId, messageTaskId, numbers, words)));
    return;
  }
  await start(proposalRevisionWorkflow, [organizationId, messageTaskId, numbers, words]);
}

/** Starts one run of a recurring job, or a "Run again" of its script. */
export async function dispatchScheduled(organizationId: string, taskId: string, trigger: RunTrigger): Promise<void> {
  if (inline) {
    const { options } = inline;
    inline.schedule(() => runScheduled(organizationId, taskId, trigger, options));
    return;
  }
  await start(scheduledRunWorkflow, [organizationId, taskId, trigger]);
}

/** Starts the first agent on a task that is ready to be worked on. */
export async function startIfReady(organizationId: string, taskId: string): Promise<boolean> {
  const task = await getTask(organizationId, taskId);
  if (!task || task.status !== "ready" || task.runStartedAt) return false;
  const agent = agentsOn(task).find((a) => a.status === "active");
  if (!agent) return false;
  await dispatchRun(organizationId, task.id, agent.id);
  return true;
}

/**
 * A planned job's later steps start by themselves: once every task one waits
 * for is delivered (in review or done), it leaves backlog and its agent starts.
 */
export async function startFollowers(organizationId: string, taskId: string): Promise<void> {
  const delivered = await getTask(organizationId, taskId);
  for (const id of await followersReady(organizationId, taskId)) {
    const follower = await updateTask(organizationId, id, { status: "ready" });
    await addMessage(id, { author: "Mach1", kind: "event", body: `Starting: #${delivered?.number} is delivered.` });
    // A job's child for a person goes to them now; their assistant or a notification tells them.
    if (follower?.assigneeKind === "person") await updateTask(organizationId, id, { status: "waiting" });
    else await startIfReady(organizationId, id);
  }
}

/**
 * A job's coordinator wakes when nothing it started is still in flight (the
 * batch is in), or straight away when a child done by the Worker asks
 * something or fails. Only while it's waiting on its children: a job that
 * asked the person, or reported, waits for them instead.
 */
export async function wakeJob(organizationId: string, taskId: string): Promise<void> {
  const task = await getTask(organizationId, taskId);
  if (!task) return;
  const jobId = task.parentTaskId ?? task.id;
  const children = await listChildren(organizationId, jobId);
  if (children.length === 0) return;
  const asking = children.filter(needsAnswer);
  if (asking.length === 0 && children.some(inFlight)) return;
  const job = task.parentTaskId ? await getTask(organizationId, jobId) : task;
  const coordinator = job && agentsOn(job).find((a) => a.status === "active");
  if (!job || !coordinator || !(await claimJobWake(organizationId, job.id))) return;
  const list = (tasks: { number: number }[]) => tasks.map((t) => `#${t.number}`).join(", ");
  await addMessage(job.id, {
    author: "Mach1",
    kind: "event",
    body: asking.length ? `${list(asking)} needs the coordinator.` : `Everything started is in: ${list(children.filter((c) => c.status !== "cancelled"))}.`,
  });
  await dispatchRun(organizationId, job.id, coordinator.id);
}
