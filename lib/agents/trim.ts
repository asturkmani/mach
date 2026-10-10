// A long run reads a lot (search hits, whole pages, command output), and every
// model call resends all of it. Once a run's messages pass a size, the older
// tool results are cut down to a short note of what they held, so the agent
// keeps a working context without a second agent to read for it. The newest
// results stay whole. Trimming moves in blocks, so the start of the prompt
// stays the same from one step to the next and prompt caching keeps working.

/** Below this many characters in all, nothing is trimmed. */
export const TRIM_ABOVE = 240_000;
/** The newest tool results always kept whole. */
const KEEP_NEWEST = 6;
/** How many results the trimmed boundary moves by at a time. */
const BLOCK = 8;
/** Results shorter than this are kept even when old. */
const SMALL = 1_500;

type Output = { type: string; value?: unknown };
type ResultPart = { type: "tool-result"; toolName: string; output: Output };
type Message = { role: string; content: unknown };

const isResult = (part: unknown): part is ResultPart =>
  typeof part === "object" && part !== null && (part as { type?: unknown }).type === "tool-result";

const sizeOf = (value: unknown): number => (typeof value === "string" ? value.length : JSON.stringify(value ?? "").length);

function results(message: Message): ResultPart[] {
  return Array.isArray(message.content) ? message.content.filter(isResult) : [];
}

/** The messages with old, large tool results replaced by a note; the same array when nothing needs trimming. */
export function trimToolResults<M extends Message>(messages: M[], { above = TRIM_ABOVE }: { above?: number } = {}): M[] {
  const total = messages.reduce((sum, m) => sum + sizeOf(m.content), 0);
  if (total <= above) return messages;
  const count = messages.reduce((n, m) => n + results(m).length, 0);
  // Results before this index (counting from the oldest) are trimmed; it moves a block at a time.
  const boundary = Math.floor(Math.max(0, count - KEEP_NEWEST) / BLOCK) * BLOCK;
  if (boundary === 0) return messages;
  let seen = 0;
  return messages.map((message) => {
    if (!Array.isArray(message.content) || !results(message).length) return message;
    const content = message.content.map((part: unknown) => {
      if (!isResult(part)) return part;
      const index = seen++;
      const size = sizeOf(part.output.value);
      if (index >= boundary || size < SMALL || part.output.type === "text" && String(part.output.value).startsWith("[Trimmed")) return part;
      return {
        ...part,
        output: {
          type: "text",
          value: `[Trimmed to save room: an earlier ${part.toolName} result of ${size.toLocaleString("en")} characters. Run it again if you need it, or check your notes and files.]`,
        },
      };
    });
    return { ...message, content };
  });
}
