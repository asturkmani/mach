/**
 * A review as a durable step (lib/learning/review.ts). Loaded, not imported,
 * so the workflow's bundle doesn't take in the models and the database.
 */
export async function reviewRoundStep(organizationId: string, taskId: string): Promise<string> {
  "use step";
  const { reviewRound } = await import("@/lib/learning/review");
  return reviewRound(organizationId, taskId);
}

export async function reviseProposalsStep(organizationId: string, messageTaskId: string, numbers: number[], words: string): Promise<string> {
  "use step";
  const { reviseProposals } = await import("@/lib/learning/review");
  return reviseProposals(organizationId, messageTaskId, numbers, words);
}
