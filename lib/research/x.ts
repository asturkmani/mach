import "server-only";

import { byokCredentials } from "@/lib/ai/keys";

// Searching X (Twitter) through xAI's API: Grok runs the search on X itself
// (its x_search tool) and reports what the posts say, with links. Nobody signs
// in to X: it uses the company's own xAI key if they added one (Settings → AI),
// else Mach1's (XAI_API_KEY). xAI bills per search, so it's for questions
// that need X, not every lookup. Reddit falls back to Grok's web search
// (reddit.ts) through the same call.

const RESPONSES_URL = "https://api.x.ai/v1/responses";
/** xAI takes at most this many handles in one search. */
export const HANDLES_PER_SEARCH = 20;
/** More accounts than one search takes are searched in batches, up to this many. */
const MAX_HANDLES = 60;

export type XSearch = { query: string; handles?: string[]; fromDate?: string; toDate?: string };

let testFetch: typeof fetch | null = null;
/** Tests answer for xAI. */
export function setXaiFetch(next: typeof fetch | null): void {
  testFetch = next;
}

export const NO_XAI_KEY = "isn't set up: Mach1 needs XAI_API_KEY, or an admin can add the company's own xAI key in Settings → AI.";

/** The company's own xAI key, else Mach1's; null when there's neither. */
export async function xaiKey(organizationId: string): Promise<string | null> {
  const own = (await byokCredentials(organizationId)).xai?.[0]?.apiKey;
  return own || process.env.XAI_API_KEY || null;
}

export const cleanHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?]/)[0];

type XaiResponse = { output?: { type?: string; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[] };

/**
 * One request to Grok with one of xAI's search tools (x_search, web_search):
 * its report, then the links it cited. Problems come back as a sentence for
 * the model, naming what to do instead.
 */
export async function grokSearch(apiKey: string, tool: Record<string, unknown>, prompt: string, what = "X search"): Promise<string> {
  let response: Response;
  try {
    response = await (testFetch ?? fetch)(RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.X_SEARCH_MODEL || "grok-4-fast", input: [{ role: "user", content: prompt }], tools: [tool] }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    return (error as Error).name === "TimeoutError" ? `${what} took too long. Try a narrower question.` : `Couldn't reach ${what}. Try again.`;
  }
  if (!response.ok) {
    console.error(`xAI ${String(tool.type)} failed (${response.status})`, (await response.text().catch(() => "")).slice(0, 300));
    return response.status === 401 || response.status === 403
      ? `${what} was refused: the xAI key isn't valid (Settings → AI, or XAI_API_KEY).`
      : response.status === 429
        ? `${what} is rate-limited right now. Try again in a minute, or use web_search.`
        : `${what} failed (${response.status}). Try again, or use web_search.`;
  }
  const data = (await response.json()) as XaiResponse;
  const parts = (data.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text");
  const text = parts.map((p) => p.text ?? "").join("\n").trim();
  const links = [...new Set(parts.flatMap((p) => p.annotations ?? []).filter((a) => a.type === "url_citation" && a.url).map((a) => a.url!))];
  if (!text) return `${what} found nothing to report.`;
  return `${text}${links.length ? `\n\nCited:\n${links.slice(0, 20).map((l) => `- ${l}`).join("\n")}` : ""}`;
}

function xPrompt({ query, handles, fromDate, toDate }: XSearch): string {
  const who = handles?.length ? `Search only posts from ${handles.map((h) => `@${h}`).join(", ")}.` : "Search all of X.";
  const when = fromDate || toDate ? ` Only posts ${[fromDate && `from ${fromDate}`, toDate && `up to ${toDate}`].filter(Boolean).join(" ")}.` : "";
  return `${who}${when}

What to find: ${query}

Report what the posts actually say, most relevant first, up to 12 posts. For each: @handle, date, what they said in a sentence (quote the key words exactly), the numbers they gave, and the post's link. Then, in two short lines: the overall read (positive, negative or mixed, and what's driving it), and the most credible post that disagrees. Only report what's in the posts, never your own view. If you found little, say so plainly.`;
}

function xTool({ handles, fromDate, toDate }: XSearch): Record<string, unknown> {
  return {
    type: "x_search",
    ...(handles?.length ? { allowed_x_handles: handles } : {}),
    ...(fromDate ? { from_date: fromDate } : {}),
    ...(toDate ? { to_date: toDate } : {}),
  };
}

/** Searches X, in batches when there are more accounts than one search takes. */
export async function searchX(organizationId: string, search: XSearch): Promise<string> {
  const apiKey = await xaiKey(organizationId);
  if (!apiKey) return `X search ${NO_XAI_KEY} Use web_search instead.`;
  const handles = [...new Set((search.handles ?? []).map(cleanHandle).filter(Boolean))];
  if (handles.length <= HANDLES_PER_SEARCH) {
    const one = { ...search, handles };
    return grokSearch(apiKey, xTool(one), xPrompt(one));
  }
  const batches: string[][] = [];
  for (let i = 0; i < Math.min(handles.length, MAX_HANDLES); i += HANDLES_PER_SEARCH) batches.push(handles.slice(i, i + HANDLES_PER_SEARCH));
  const results = await Promise.all(
    batches.map((batch) => {
      const one = { ...search, handles: batch };
      return grokSearch(apiKey, xTool(one), xPrompt(one));
    }),
  );
  const skipped = handles.length > MAX_HANDLES ? `\n\n(${handles.length - MAX_HANDLES} more accounts weren't searched: name the ones that matter most.)` : "";
  return `${results.map((r, i) => `From ${batches[i].map((h) => `@${h}`).join(", ")}:\n${r}`).join("\n\n")}${skipped}`;
}
