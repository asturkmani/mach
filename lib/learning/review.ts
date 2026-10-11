import "server-only";

import { SKILLS } from "@/lib/agents/skills";
import { companySkillsFor } from "@/lib/company-skills";
import { getDb } from "@/lib/db";
import { gate } from "@/lib/learning/gate";
import { runLearner } from "@/lib/learning/learner";
import { proposalsOn, proposeChanges, skippedBefore } from "@/lib/learning/proposals";
import { buildRunRecord } from "@/lib/learning/record";
import { getTask, type Task } from "@/lib/tasks";

// The review of a round of work (docs/agent-design.md, Learning on the job).
// It runs once per round, when the round closes (a person replies on the
// result or marks it done, or a repeating run reports), in the background,
// after the report has gone out. A standalone task gets one review per round;
// a job one review covering the coordinator and all its children.

/** Takes the task's review: the time of the review before (null for the first), or undefined if another just took it. */
async function claimReview(taskId: string): Promise<Date | null | undefined> {
  const [row] = await getDb().query<{ previous: Date | null }>(
    `with prior as (select reviewed_at from tasks where id = $1)
     update tasks t set reviewed_at = now() from prior
     where t.id = $1 and (prior.reviewed_at is null or prior.reviewed_at < now() - interval '5 seconds')
     returning prior.reviewed_at as previous`,
    [taskId],
  );
  return row ? row.previous : undefined;
}

/** Who a review's changes go to: the person the work was for. */
const personFor = (task: Task) => task.createdByPersonId ?? task.members.find((m) => m.type === "person")?.id ?? null;

async function saveReview(organizationId: string, task: Task, record: string, gateAnswers: object, model: string): Promise<string> {
  const [row] = await getDb().query<{ id: string }>(
    `insert into learning_reviews (organization_id, task_id, record, gate, gate_model) values ($1, $2, $3, $4::jsonb, $5) returning id`,
    [organizationId, task.id, record, JSON.stringify(gateAnswers), model],
  );
  return row.id;
}

async function finishReview(reviewId: string, learnerRan: boolean, outcome: string): Promise<void> {
  await getDb().query("update learning_reviews set learner_ran = $2, outcome = $3 where id = $1", [reviewId, learnerRan, outcome]);
}

/** Reviews the round that just closed on a task: the gate, then (if it says so) the learner and its proposals. */
export async function reviewRound(organizationId: string, taskId: string): Promise<string> {
  const task = await getTask(organizationId, taskId);
  if (!task || task.kind !== "task" || task.parentTaskId) return "Not reviewed: only a task or a job is.";
  const since = await claimReview(task.id);
  if (since === undefined) return "Not reviewed: a review just ran.";
  const record = await buildRunRecord(organizationId, task, since);
  if (record.runs === 0) return "Not reviewed: no agent worked on it since the last review.";
  const checked = await gate(organizationId, record.text);
  const reviewId = await saveReview(organizationId, task, record.text, checked.probabilities, checked.model);
  if (!checked.learn) {
    await finishReview(reviewId, false, "The gate found nothing to learn.");
    return "Nothing to learn.";
  }
  const personId = personFor(task);
  const catalogue = [...SKILLS, ...(await companySkillsFor(organizationId, personId))];
  const { drafts, text } = await runLearner(organizationId, {
    task,
    record,
    gate: checked.probabilities,
    catalogue,
    skipped: await skippedBefore(organizationId, record.skills),
  });
  if (!drafts.length || !personId) {
    await finishReview(reviewId, true, text || "The learner found nothing to change.");
    return text || "Nothing to change.";
  }
  const proposals = await proposeChanges(organizationId, { reviewId, task, personId, drafts });
  await finishReview(reviewId, true, `Proposed ${proposals.length}: ${text}`);
  return `Proposed ${proposals.length} change${proposals.length > 1 ? "s" : ""}.`;
}

/** A person answered changes in their own words ("yes, but only the trust"): the learner revises them. */
export async function reviseProposals(organizationId: string, messageTaskId: string, numbers: number[], words: string): Promise<string> {
  const proposals = (await proposalsOn(organizationId, messageTaskId)).filter((p) => p.status === "pending" && (!numbers.length || numbers.includes(p.number)));
  const [review] = await getDb().query<{ id: string; task_id: string; record: string }>(
    "select r.id, r.task_id, r.record from learning_reviews r join skill_proposals p on p.review_id = r.id where p.message_task_id = $1 limit 1",
    [messageTaskId],
  );
  const task = review && (await getTask(organizationId, review.task_id));
  const personId = proposals[0]?.personId;
  if (!task || !personId || !proposals.length) return "Nothing to revise.";
  // The record the changes cite, as it was: its ids are numbered as the learner saw them.
  const ids = new Set(review.record.match(/^[SM]\d+(?= )/gm) ?? []);
  const catalogue = [...SKILLS, ...(await companySkillsFor(organizationId, personId))];
  const { drafts } = await runLearner(organizationId, {
    task,
    record: { text: review.record, ids, scripts: new Map(), skills: [], runs: 1 },
    gate: {},
    catalogue,
    skipped: [],
    revise: { proposals, words },
  });
  if (!drafts.length) return "Revised: nothing left to propose.";
  const revised = await proposeChanges(organizationId, { reviewId: review.id, task, personId, drafts });
  return `Revised: ${revised.length} change${revised.length > 1 ? "s" : ""} sent again.`;
}
