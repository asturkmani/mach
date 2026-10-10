/**
 * After an agent's run: the tasks waiting on this one start if it delivered
 * (lib/agents/dispatch.ts). A step, so the workflow records it once. The
 * dispatcher is loaded here, not imported, as it starts the workflows that
 * call this.
 */
export async function startFollowersStep(organizationId: string, taskId: string): Promise<void> {
  "use step";
  const { startFollowers } = await import("@/lib/agents/dispatch");
  await startFollowers(organizationId, taskId);
}
