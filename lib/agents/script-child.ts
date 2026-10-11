import { wakeJobStep } from "@/lib/agents/job-steps";
import { endRun, logRun } from "@/lib/agents/run-steps";
import { runAgentChain, type RunOptions } from "@/lib/agents/runner";
import { closeSandbox, runSkillScript, type ReplayResult } from "@/lib/agents/sandbox-steps";
import { beginScriptChild, reportScript, scriptToWorker } from "@/lib/agents/script-steps";

// Runs a job's script child (lib/agents/script-steps.ts), in the
// script-child workflow. Like the runner, it only orchestrates: every
// database change and sandbox action is a durable step.

export async function runScriptChild(organizationId: string, taskId: string, options: RunOptions = {}): Promise<void> {
  const plan = await beginScriptChild(organizationId, taskId);
  if (plan.type === "skip") return;
  const { context, label } = plan;
  const startedAt = new Date().toISOString();
  let result: ReplayResult;
  try {
    result = await runSkillScript(context, plan);
    if (result.ok) await reportScript(context, result, label);
  } catch (error) {
    result = { ok: false, reason: "failed", log: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await closeSandbox(context);
    } catch (error) {
      console.error(`Couldn't close the sandbox for task ${taskId}`, error);
    }
    await endRun(context);
  }
  await logRun(context, {
    outcome: result.ok ? "finished" : "failed",
    skillsPinned: [plan.skill],
    skillsLoaded: [],
    steps: [{ tool: "run_code", detail: `Running ${label}`, ok: result.ok }],
    modelSteps: 0,
    startedAt,
  }).catch((error) => console.error(`Couldn't log the script run on task ${taskId}`, error));
  if (result.ok) {
    await wakeJobStep(organizationId, taskId);
    return;
  }
  await scriptToWorker(context, result, label);
  await runAgentChain(organizationId, taskId, context.agentId, options);
}
