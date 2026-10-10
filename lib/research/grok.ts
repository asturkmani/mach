import "server-only";

import { byokCredentials } from "@/lib/ai/keys";

// Grok's own search tools on xAI's API (x_search, web_search): Grok runs the
// search and reports what it found, with links. It's how X is searched when
// Mach1 has no X API app, and Reddit when it has no Reddit app. It uses the
// company's own xAI key if they added one (Settings → AI), else Mach1's
// (XAI_API_KEY).

const RESPONSES_URL = "https://api.x.ai/v1/responses";

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

type XaiResponse = { output?: { type?: string; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[] };

/**
 * One request to Grok with one of xAI's search tools: its report, then the
 * links it cited. Problems come back as a sentence for the model, naming what
 * to do instead.
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
