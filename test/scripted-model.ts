import { MockLanguageModelV4 } from "ai/test";

type LanguageModelV4StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** One model step: a list of (parallel) tool calls, a final text reply, or an error to throw. */
export type Step = Array<[toolName: string, input: object]> | string | Error;

/** A mock model that plays back one step per call, repeating the last one if called again. */
export function scriptedModel(steps: Step[]) {
  let call = 0;
  const model = new MockLanguageModelV4({
    // Streaming callers (the chat) get the same steps, as stream parts.
    doStream: async (options) => {
      const result = await model.doGenerate(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      result.content.forEach((part, i) => {
        if (part.type === "text") {
          parts.push({ type: "text-start", id: `t${i}` }, { type: "text-delta", id: `t${i}`, delta: part.text }, { type: "text-end", id: `t${i}` });
        } else parts.push(part as LanguageModelV4StreamPart);
      });
      parts.push({ type: "finish", finishReason: result.finishReason, usage: result.usage });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
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
  return model;
}
