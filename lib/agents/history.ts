import { asSchema, safeValidateUIMessages, type ToolSet, type UIMessage } from "ai";

// Chat history is stored in Postgres and re-validated against the current
// tools before every agent run. This module makes stored history safe to send
// back to the agent.

type Json = Record<string, unknown>;
type Repair = (output: Json) => Json;

const pick = (o: Json, camel: string, snake: string) => o[camel] ?? o[snake];
const withoutUndefined = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * AI Gateway returns some provider-executed tool results in its raw API shape
 * (snake_case, `excerpts` arrays) rather than the shape the AI SDK declares
 * for those tools, which makes the next request fail validation. These map
 * the raw shape onto the declared one. They only run on outputs that fail
 * validation, so they stop doing anything once the SDK is fixed upstream.
 */
const REPAIRS: Record<string, Repair> = {
  web_search: (o) => {
    if (typeof o.error === "string") return o;
    const results = Array.isArray(o.results) ? (o.results as Json[]) : [];
    return {
      searchId: pick(o, "searchId", "search_id"),
      results: results.map((r) =>
        withoutUndefined({
          url: r.url,
          title: r.title,
          excerpt: r.excerpt ?? (Array.isArray(r.excerpts) ? r.excerpts.join("\n\n") : undefined),
          publishDate: pick(r, "publishDate", "publish_date"),
          relevanceScore: pick(r, "relevanceScore", "relevance_score"),
        }),
      ),
    };
  },
  fetch_page: (o) => {
    if (typeof o.error === "string") return withoutUndefined({ ...o, statusCode: pick(o, "statusCode", "status_code") });
    return withoutUndefined({
      id: o.id,
      content: o.content,
      contentType: pick(o, "contentType", "content_type"),
      encoding: o.encoding,
      headers: o.headers,
      statusCode: pick(o, "statusCode", "status_code"),
    });
  },
};

async function isValidOutput(tools: ToolSet, toolName: string, output: unknown): Promise<boolean> {
  const schema = tools[toolName]?.outputSchema;
  if (!schema) return true;
  const result = await asSchema(schema).validate?.(output);
  return result ? result.success : true;
}

/** What the model reads for a tool call that never got its result. */
export const CUT_OFF = "This didn't finish: the reply was cut off before the tool returned. Run it again if it's still needed.";

/** A stored call to a tool that has since been retired, as a short note of what it did. */
function retired(toolName: string, part: UIMessage["parts"][number]): UIMessage["parts"][number] {
  const { state, output, errorText } = part as { state?: string; output?: unknown; errorText?: string };
  const result = state === "output-available" ? JSON.stringify(output ?? null) : state === "output-error" ? `failed: ${errorText ?? ""}` : "didn't finish";
  return { type: "text", text: `[Earlier, ${toolName} (a tool you no longer have): ${result.length > 600 ? `${result.slice(0, 599)}…` : result}]` };
}

async function repairPart(tools: ToolSet, part: UIMessage["parts"][number]) {
  // A tool that's been retired (start_coding became spawn_worker) would fail validation and take its
  // whole message with it: keep the message, with the call as a note of what it did.
  if (part.type.startsWith("tool-") && !tools[part.type.slice("tool-".length)]) return retired(part.type.slice("tool-".length), part);
  // A reply cut off mid-tool (the request ended, the server restarted) leaves a
  // call with no result, and providers refuse a conversation like that: record
  // it as failed so the conversation carries on.
  if ((part.type.startsWith("tool-") || part.type === "dynamic-tool") && "state" in part) {
    if (part.state === "input-streaming" || part.state === "input-available" || part.state === "approval-requested") {
      const { input, ...rest } = part as typeof part & { input?: unknown };
      return { ...rest, state: "output-error", input: input ?? {}, errorText: CUT_OFF } as unknown as typeof part;
    }
  }
  const toolName = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : null;
  // The browser agent's screenshots are shown to the Chief of Staff in the turn they're taken; after
  // that the conversation keeps links to the saved files, not the images.
  if (toolName === "use_browser" && "state" in part && part.state === "output-available") {
    const output = (part as { output?: { evidence?: { image?: string | null }[] } }).output;
    if (output?.evidence?.some((e) => e.image)) {
      return { ...part, output: { ...output, evidence: output.evidence.map((e) => ({ ...e, image: null })) } } as typeof part;
    }
  }
  const repair = toolName ? REPAIRS[toolName] : undefined;
  if (!toolName || !repair || !("state" in part) || part.state !== "output-available") return part;

  const output = (part as { output?: unknown }).output;
  if (await isValidOutput(tools, toolName, output)) return part;
  if (output && typeof output === "object") {
    const repaired = repair(output as Json);
    if (await isValidOutput(tools, toolName, repaired)) return { ...part, output: repaired };
  }
  console.warn(`Dropping a ${toolName} result that doesn't match its schema`);
  return null;
}

/**
 * Repairs known tool-output mismatches, then drops any message that still
 * fails validation, so one bad stored message can't break the whole chat.
 */
export async function prepareHistory<T extends UIMessage>(messages: T[], tools: ToolSet): Promise<T[]> {
  const prepared: T[] = [];
  for (const message of messages) {
    const parts = (await Promise.all(message.parts.map((part) => repairPart(tools, part)))).filter(
      (part) => part !== null,
    );
    if (!parts.some((part) => part.type !== "step-start")) continue;

    const candidate = { ...message, parts } as T;
    const result = await safeValidateUIMessages({ messages: [candidate], tools });
    if (result.success) prepared.push(candidate);
    else console.warn(`Dropping stored message ${message.id} that no longer validates`, result.error);
  }
  return prepared;
}
