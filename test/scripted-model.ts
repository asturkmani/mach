import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** One model step: a list of (parallel) tool calls, a final text reply, or an error to throw. */
export type Step = Array<[toolName: string, input: object]> | string | Error;

/** A mock model that plays back one step per call, repeating the last one if called again. */
export function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      if (step instanceof Error) throw step;
      if (typeof step === "string") {
        return {
          content: [{ type: "text" as const, text: step }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: step.map(([toolName, input], i) => ({
          type: "tool-call" as const,
          toolCallId: `${call}-${i}`,
          toolName,
          input: JSON.stringify(input),
        })),
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
