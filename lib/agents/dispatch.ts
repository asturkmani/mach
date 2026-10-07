import "server-only";

import { after } from "next/server";

import { runAgentOnTask, type RunOptions } from "@/lib/agents/runner";
import { agentsOn, countPersonComments, getTask, type Task, type TaskMessage } from "@/lib/tasks";

// Starts agent runs in the background, after the response that triggered them
// has been sent. A run that hands off to another agent on the same task starts
// that agent's run straight away.

type Work = () => Promise<void>;

let schedule: (work: Work) => void = (work) => after(work);
let runOptions: RunOptions = {};

/** Tests run the work inline (or capture it) instead of using after(). */
export function setScheduler(next: ((work: Work) => void) | null, options: RunOptions = {}): void {
  schedule = next ?? ((work) => after(work));
  runOptions = options;
}

export function dispatchRun(organizationId: string, taskId: string, agentId: string): void {
  schedule(async () => {
    let next: string | undefined = agentId;
    while (next) {
      const current: string = next;
      try {
        const commentsBefore = await countPersonComments(taskId);
        const outcome = await runAgentOnTask(organizationId, taskId, current, runOptions);
        if (outcome.type === "handed_off") {
          next = outcome.agentId;
        } else if (
          (outcome.type === "asked" || outcome.type === "finished") &&
          (await countPersonComments(taskId)) > commentsBefore
        ) {
          // Someone replied while the agent was working; it didn't see that, so it goes again.
          next = current;
        } else {
          next = undefined;
        }
      } catch (error) {
        console.error(`Agent run on task ${taskId} failed`, error);
        next = undefined;
      }
    }
  });
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
  dispatchRun(organizationId, task.id, agent.id);
  return true;
}
