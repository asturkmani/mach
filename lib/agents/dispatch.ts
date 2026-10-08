import "server-only";

import { start } from "workflow/api";

import { runAgentChain, type RunOptions } from "@/lib/agents/runner";
import { runScheduled, type RunTrigger } from "@/lib/agents/scheduled";
import { agentsOn, getTask } from "@/lib/tasks";
import { agentRunWorkflow } from "@/workflows/agent-run";
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
