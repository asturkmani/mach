import { runScheduled, type RunTrigger } from "@/lib/agents/scheduled";

/**
 * One run of a recurring job, or a person's "Run again": replays run.sh (or
 * wakes the agent) as a durable workflow, and reports on the job's card.
 */
export async function scheduledRunWorkflow(organizationId: string, taskId: string, trigger: RunTrigger): Promise<void> {
  "use workflow";
  await runScheduled(organizationId, taskId, trigger);
}
