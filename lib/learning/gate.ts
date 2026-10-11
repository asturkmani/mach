import "server-only";

import { decide, type Answer } from "@/lib/ai/decide";

// Stage 1 of a review (docs/agent-design.md): one decision-model call on the
// run record, asking whether there's anything to learn. Set to catch more
// rather than less: a false yes costs one learner run that finds nothing; a
// false no means the lesson is learned the next time it comes up. Every
// learner run labels the gate's answer, for setting these thresholds.

const QUESTIONS = {
  learn: {
    type: "choice",
    instructions: "What, if anything, should be learned from this run for next time?",
    criteria: {
      nothing: "Nothing: it went as expected, or there's nothing that would recur",
      integration_skill: "How one of the company's systems works: endpoints, quirks, steps through its web app",
      workflow_skill: "How the company does this piece of work: steps, who gets what, rules, approvals",
      new_skill: "A new piece of work worth keeping as a skill",
      profile: "A fact about the company: an entity, a priority, who looks after what",
    },
  },
  fact: { type: "boolean", instructions: "Did the run surface a fact about the company (an entity, a priority, who handles what)?" },
  corrected: { type: "boolean", instructions: "Did a person correct how the work was done?" },
  departed: { type: "boolean", instructions: "Did the run depart from a skill it was given?" },
  script: { type: "boolean", instructions: "Was a script written or rewritten, and did it work?" },
  repeats: { type: "boolean", instructions: "Will this work be asked for again?" },
} as const;

/** The learner runs when "nothing" is less likely than this… */
const NOTHING_BELOW = 0.7;
/** …or any of the yes-or-no signals is more likely than this. */
const SIGNAL_ABOVE = 0.5;

export type GateResult = { learn: boolean; probabilities: Record<string, number | Record<string, number>>; model: string };

export async function gate(organizationId: string, record: string): Promise<GateResult> {
  const { answers, model } = await decide(organizationId, record, QUESTIONS);
  const probabilities = Object.fromEntries(
    Object.entries(answers).map(([id, a]: [string, Answer]) => [id, a.type === "choice" ? a.probabilities : a.probability]),
  );
  const nothing = answers.learn.type === "choice" ? (answers.learn.probabilities.nothing ?? (answers.learn.choice === "nothing" ? 1 : 0)) : 1;
  const signals = (["fact", "corrected", "departed", "script", "repeats"] as const).map((id) => {
    const a = answers[id];
    return a.type === "boolean" ? a.probability : 0;
  });
  return { learn: nothing < NOTHING_BELOW || signals.some((p) => p > SIGNAL_ABOVE), probabilities, model };
}
