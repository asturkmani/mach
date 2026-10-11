import { runScriptChild } from "@/lib/agents/script-child";

/** A job's script child: a skill's script run without a model, and the Worker fixing it if it fails. */
export async function scriptChildWorkflow(organizationId: string, taskId: string): Promise<void> {
  "use workflow";
  await runScriptChild(organizationId, taskId);
}
