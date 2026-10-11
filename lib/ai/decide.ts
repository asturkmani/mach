import "server-only";

import { experimental_decide, gateway, generateText, Output } from "ai";
import { z } from "zod";

import { companyModel } from "@/lib/ai/company-model";
import { roleModel } from "@/lib/ai/lineup";

// Decisions with a known set of answers, made by a decision model: Jev, from
// TypeSafe AI, on AI Gateway (docs/agent-design.md). It answers typed
// questions about one state with probabilities instead of text, in well under
// a second, for a fraction of a cent. If it's down or errors, the same
// questions go to the background language model, answered as probabilities.
// Code turns numbers and dates into plain facts before they reach it: that's
// where decision models are weak.

/** The decision model, pinned so a new version doesn't move thresholds under us. */
export const DECISION_MODEL = process.env.MACH_DECISION_MODEL || "typesafe-ai/jev";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "boolean"; instructions: string };

export type Answer = { type: "choice"; choice: string; probabilities: Record<string, number> } | { type: "boolean"; probability: number };

export type Decision<Q extends Record<string, Question>> = { answers: { [K in keyof Q]: Answer }; model: string };

type Decider = (state: string, questions: Record<string, Question>) => Promise<Decision<Record<string, Question>>>;

let testDecider: Decider | null = null;
/** Tests answer decisions themselves. */
export function setDecider(decider: Decider | null): void {
  testDecider = decider;
}

/** Answers the questions about the state: with the decision model, else the company's background model. */
export async function decide<Q extends Record<string, Question>>(organizationId: string, state: string, questions: Q): Promise<Decision<Q>> {
  if (testDecider) return testDecider(state, questions) as Promise<Decision<Q>>;
  try {
    const result = await experimental_decide({ model: gateway.decisionModel(DECISION_MODEL), state, questions, maxRetries: 1 });
    const answers = Object.fromEntries(
      Object.entries(result.answers).map(([id, a]) => {
        const answer = a as { type: string; choice?: string; probabilities?: Record<string, number>; probability?: number };
        return [
          id,
          answer.type === "choice"
            ? { type: "choice", choice: answer.choice!, probabilities: answer.probabilities ?? { [answer.choice!]: 1 } }
            : { type: "boolean", probability: answer.probability ?? 0 },
        ];
      }),
    ) as Decision<Q>["answers"];
    return { answers, model: result.response.modelId || DECISION_MODEL };
  } catch (error) {
    console.error(`${DECISION_MODEL} failed; asking the background model instead`, (error as Error).message);
    return withLanguageModel(organizationId, state, questions);
  }
}

/** The fallback: the same questions to a language model, which gives its probabilities as numbers. */
async function withLanguageModel<Q extends Record<string, Question>>(organizationId: string, state: string, questions: Q): Promise<Decision<Q>> {
  const schema = z.object(
    Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === "choice"
          ? z.object(Object.fromEntries(Object.keys(q.criteria).map((option) => [option, z.number().min(0).max(1)])))
          : z.number().min(0).max(1).describe("The probability the answer is yes."),
      ]),
    ),
  );
  const asked = Object.entries(questions)
    .map(([id, q]) =>
      q.type === "choice"
        ? `${id}: ${q.instructions} Give each option's probability (they sum to 1):\n${Object.entries(q.criteria)
            .map(([option, meaning]) => `  - ${option}${meaning ? `: ${meaning}` : ""}`)
            .join("\n")}`
        : `${id}: ${q.instructions} Give the probability it's yes.`,
    )
    .join("\n");
  const model = roleModel("background");
  const { output } = await generateText({
    model: companyModel(organizationId, model),
    system: "You answer questions about a state with calibrated probabilities. Judge only from the state.",
    prompt: `<state>\n${state}\n</state>\n\nQuestions:\n${asked}`,
    output: Output.object({ schema }),
  });
  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      const value = (output as Record<string, unknown>)[id];
      if (q.type === "boolean") return [id, { type: "boolean", probability: Number(value) || 0 }];
      const probabilities = value as Record<string, number>;
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? Object.keys(q.criteria)[0];
      return [id, { type: "choice", choice, probabilities }];
    }),
  ) as Decision<Q>["answers"];
  return { answers, model };
}
