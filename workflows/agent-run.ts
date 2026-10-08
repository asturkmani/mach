import { runAgentChain } from "@/lib/agents/runner";

/**
 * Runs an agent on a task, plus any agents it hands off to, as a durable
 * workflow: each model call and database change is a step that is retried on
 * failure, and the run can outlast any single function invocation.
 */
export async function agentRunWorkflow(organizationId: string, taskId: string, agentId: string): Promise<void> {
  "use workflow";
  await runAgentChain(organizationId, taskId, agentId);
}
