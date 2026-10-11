import { reviewRoundStep, reviseProposalsStep } from "@/lib/learning/review-steps";

/**
 * The review of a round of work that just closed (docs/agent-design.md,
 * Learning on the job): the gate, then the learner and its proposals. In the
 * background, after the report has gone out, so it never delays anyone.
 */
export async function learningReviewWorkflow(organizationId: string, taskId: string): Promise<void> {
  "use workflow";
  await reviewRoundStep(organizationId, taskId);
}

/** A person answered proposed changes in their own words: the learner revises them. */
export async function proposalRevisionWorkflow(organizationId: string, messageTaskId: string, numbers: number[], words: string): Promise<void> {
  "use workflow";
  await reviseProposalsStep(organizationId, messageTaskId, numbers, words);
}
