import "server-only";

import { start } from "workflow/api";

import { runAgentChain, type RunOptions } from "@/lib/agents/runner";
import { agentsOn, getTask, type Task, type TaskMessage } from "@/lib/tasks";
import { agentRunWorkflow } from "@/workflows/agent-run";

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

/**
 * Which agent should pick the task up after a person speaks: one they
 * mentioned by name, else the agent that last asked or reported, else the
 * first active agent on the task.
 */
export function agentToWake(task: Task, messages: TaskMessage[], text = ""): string | undefined {
  const active = agentsOn(task).filter((a) => a.status === "active");
  const mentioned = active.find((a) => text.toLowerCase().includes(`@${a.name.toLowerCase()}`));
  if (mentioned) return mentioned.id;
  const last = [...messages].reverse().find((m) => m.agentId && (m.kind === "ask" || m.kind === "result"));
  if (last && active.some((a) => a.id === last.agentId)) return last.agentId!;
  return active[0]?.id;
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
