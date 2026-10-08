import { endRun } from "@/lib/agents/run-steps";
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
  if (plan.type === "agent") return runAgentChain(organizationId, taskId, plan.agentId, options);

  const { context, label } = plan;
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
  if (!result.ok) {
    await replayToAgent(context, result, label);
    await runAgentChain(organizationId, taskId, context.agentId, options);
  }
}
