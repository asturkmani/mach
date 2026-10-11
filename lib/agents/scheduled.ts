import { reviewRoundClosedStep } from "@/lib/agents/follower-steps";
import { endRun, logRun } from "@/lib/agents/run-steps";
import { runAgentChain, type RunOptions } from "@/lib/agents/runner";
import { beginScheduledRun, replayToAgent, reportReplay, type RunTrigger } from "@/lib/agents/schedule-steps";
import { closeSandbox, replayScript, type ReplayResult } from "@/lib/agents/sandbox-steps";

export type { RunTrigger };

// One run of a recurring job (or a person's "Run again"). When the job has a
// run.sh it is replayed without a model and the changed deliverables become
// their next versions; the agent is woken only if it fails. Otherwise the
// agent does the job. Either way the result lands on the same card.
//
// Like the runner, this only orchestrates: every database change and sandbox
// action is a durable step.

export async function runScheduled(
  organizationId: string,
  taskId: string,
  trigger: RunTrigger,
  options: RunOptions = {},
): Promise<void> {
  const plan = await beginScheduledRun(organizationId, taskId, trigger);
  if (plan.type === "skip") return;
  if (plan.type === "agent") {
    await runAgentChain(organizationId, taskId, plan.agentId, options);
    await reviewRoundClosedStep(organizationId, taskId);
    return;
  }

  const { context, label } = plan;
  const startedAt = new Date().toISOString();
  let result: ReplayResult;
  try {
    result = await replayScript(context, label);
    if (result.ok) await reportReplay(context, result, label);
  } catch (error) {
    result = { ok: false, reason: "failed", log: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await closeSandbox(context);
    } catch (error) {
      console.error(`Couldn't close the sandbox for task ${context.taskId}`, error);
    }
    await endRun(context);
  }
  await logRun(context, {
    outcome: result.ok ? "finished" : "failed",
    skillsPinned: [],
    skillsLoaded: [],
    steps: [{ tool: "run.sh", detail: `Replaying run.sh (${label})`, ok: result.ok }],
    modelSteps: 0,
    startedAt,
  }).catch((error) => console.error(`Couldn't log the replay of task ${taskId}`, error));
  if (!result.ok) {
    await replayToAgent(context, result, label);
    await runAgentChain(organizationId, taskId, context.agentId, options);
  }
  // The repeating run reported: its round closes.
  await reviewRoundClosedStep(organizationId, taskId);
}
