import "server-only";

import { ApiError, Client } from "@xdevplatform/xdk";

import { grokSearch, NO_XAI_KEY, xaiKey } from "@/lib/research/grok";

// Searching X (Twitter) without anyone signing in. With Mach1's X API app
// (X_BEARER_TOKEN, an app-only token on X's pay-per-use plan) it's X's own
// search, through its TypeScript SDK: the posts themselves with their authors
// and engagement, from the last week or (with a from date) back to 2006, most
// engaged first. Each post read costs $0.005, so a search reads 25 at most.
// Without the app, Grok searches X (xAI's x_search) and reports what the
// posts say, on the company's xAI key or Mach1's (grok.ts).

export type XSearch = {
  /** X search terms: keywords, "exact phrases", OR, $cashtags, #hashtags. Empty: the accounts' latest posts. */
  query?: string;
  handles?: string[];
  fromDate?: string;
  toDate?: string;
  replies?: boolean;
  sort?: "relevancy" | "recency";
};

/** Accounts in one search: X's query takes 512 characters, xAI 20 handles. */
export const HANDLES_PER_SEARCH = 20;
/** More accounts than one search takes are searched in batches, up to this many. */
const MAX_HANDLES = 60;
/** Posts read per search on X's API. */
const POSTS_PER_SEARCH = 25;
/** X's recent search covers the last week; anything older is a search of the archive. */
const RECENT_DAYS = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
export type XPage = { data?: Loose[]; includes?: { users?: Loose[] } };
export type XApi = (
  query: string,
  options: { archive: boolean; startTime?: string; endTime?: string; sortOrder: "relevancy" | "recency"; maxResults: number },
) => Promise<XPage>;

let testApi: XApi | null = null;
/** Tests answer for X's API. */
export function setXApi(next: XApi | null): void {
  testApi = next;
}

/** X's search through its SDK, or null when Mach1 has no X API app. */
function xApi(): XApi | null {
  if (testApi) return testApi;
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) return null;
  const client = new Client({ bearerToken, timeout: 30_000 });
  return async (query, { archive, ...options }) => {
    const request = {
      ...options,
      postFields: ["created_at", "public_metrics", "note_post"] as ("created_at" | "public_metrics" | "note_post")[],
      // Brings each post's author_id, and the authors under includes.
      expansions: ["author_id"] as "author_id"[],
      userFields: ["name", "username", "verified", "public_metrics"] as ("name" | "username" | "verified" | "public_metrics")[],
    };
    return (archive ? await client.posts.searchAll(query, request) : await client.posts.searchRecent(query, request)) as XPage;
  };
}

const NOT_SET_UP = "isn't set up: Mach1 needs X_BEARER_TOKEN (an X API app) or XAI_API_KEY, or an admin can add the company's own xAI key in Settings → AI.";

export const cleanHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?]/)[0];

/** The search in X's query language: the terms, from any of the accounts, no reposts (or replies, unless asked). */
export function xQuery(search: XSearch, handles: string[]): string {
  const terms = search.query?.trim() ?? "";
  return [
    terms && handles.length ? `(${terms})` : terms,
    handles.length ? `(${handles.map((h) => `from:${h}`).join(" OR ")})` : "",
    "-is:retweet",
    search.replies ? "" : "-is:reply",
  ]
    .filter(Boolean)
    .join(" ");
}

const count = (n: unknown) => {
  const v = typeof n === "number" ? n : 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
};
// X is renaming tweets to posts: read either name.
const reposts = (m: Loose) => m.repostCount ?? m.retweetCount ?? 0;
const engagement = (p: Loose) => {
  const m = p.publicMetrics ?? {};
  return (m.likeCount ?? 0) + 2 * reposts(m) + 2 * (m.quoteCount ?? 0) + (m.replyCount ?? 0);
};

/** The accounts split into searches of at most twenty, each query short enough for X when a search is given. */
function batches(handles: string[], search?: XSearch, maxLength = Infinity): string[][] {
  if (!handles.length) return [[]];
  const out: string[][] = [[]];
  for (const handle of handles.slice(0, MAX_HANDLES)) {
    const current = out.at(-1)!;
    const fits = current.length < HANDLES_PER_SEARCH && (!search || xQuery(search, [...current, handle]).length <= maxLength);
    if (fits || !current.length) current.push(handle);
    else out.push([handle]);
  }
  return out;
}

async function viaApi(api: XApi, search: XSearch, handles: string[], saved: Set<string>): Promise<string> {
  const since = search.fromDate ? new Date(`${search.fromDate}T00:00:00Z`) : null;
  const archive = Boolean(since && since.getTime() < Date.now() - RECENT_DAYS * 86_400_000);
  // X wants the end at least a few seconds in the past: a date of today or later is just "now".
  const until = search.toDate ? new Date(`${search.toDate}T23:59:59Z`) : null;
  const options = {
    archive,
    startTime: since?.toISOString(),
    endTime: until && until.getTime() < Date.now() - 60_000 ? until.toISOString() : undefined,
    sortOrder: search.sort ?? "relevancy",
    maxResults: POSTS_PER_SEARCH,
  };
  const posts = new Map<string, Loose>();
  const users = new Map<string, Loose>();
  // One after another: the archive allows one search a second. X takes 512 characters a query (1,024 in the archive).
  for (const batch of batches(handles, search, archive ? 1024 : 512)) {
    const page = await api(xQuery(search, batch), options);
    for (const u of page.includes?.users ?? []) users.set(u.id, u);
    for (const p of page.data ?? []) posts.set(p.id, p);
  }
  const range = archive || search.fromDate ? `${search.fromDate ?? "the start"} to ${search.toDate ?? "now"}` : "the last 7 days";
  const what = [search.query?.trim() ? `"${search.query.trim()}"` : "", handles.length ? `from ${handles.map((h) => `@${h}`).join(", ")}` : ""]
    .filter(Boolean)
    .join(" ");
  if (!posts.size) {
    return `No posts on X ${what}, ${range}. Try fewer or broader terms${archive ? "" : ", or a from_date for older posts"}.`;
  }
  const ranked = [...posts.values()].sort((a, b) => engagement(b) - engagement(a)).slice(0, 25);
  return `X posts ${what}, ${range}, ${posts.size} found, most engaged first (★ a saved account):\n${ranked
    .map((p) => {
      const u = users.get(p.authorId) ?? {};
      const m = p.publicMetrics ?? {};
      const text = String(p.notePost?.text ?? p.noteTweet?.text ?? p.text ?? "").replace(/\s+/g, " ").trim();
      const who = `@${u.username ?? "?"} (${[u.name, u.verified ? "verified" : "", `${count(u.publicMetrics?.followersCount)} followers`].filter(Boolean).join(", ")})`;
      return [
        `- ${who}${saved.has(String(u.username).toLowerCase()) ? " ★" : ""} · ${String(p.createdAt ?? "").slice(0, 10)} · ${count(m.likeCount)} likes, ${count(reposts(m))} reposts, ${count(m.replyCount)} replies`,
        `  ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`,
        `  https://x.com/${u.username ?? "i"}/status/${p.id}`,
      ].join("\n");
    })
    .join("\n")}${handles.length > MAX_HANDLES ? `\n(${handles.length - MAX_HANDLES} more accounts weren't searched: name the ones that matter most.)` : ""}`;
}

/** What went wrong on X's side, as a sentence for the model; null when Grok should try instead. */
function apiProblem(error: unknown, query: string): string | null {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 400) return `X couldn't read the search ${query}: ${(error as Error).message}. Use plain keywords, "exact phrases", OR and $cashtags.`;
  console.error(`X search failed (${status || "no response"})`, (error as Error).message);
  if (status === 401 || status === 403) return "X refused the search: Mach1's X_BEARER_TOKEN isn't valid, or the X app is out of credit.";
  if (status === 429) return "X search is rate-limited right now. Try again in a minute, or use web_search.";
  return null;
}

function grokPrompt({ query, fromDate, toDate }: XSearch, handles: string[]): string {
  const who = handles.length ? `Search only posts from ${handles.map((h) => `@${h}`).join(", ")}.` : "Search all of X.";
  const when = fromDate || toDate ? ` Only posts ${[fromDate && `from ${fromDate}`, toDate && `up to ${toDate}`].filter(Boolean).join(" ")}.` : "";
  return `${who}${when}

What to find: ${query?.trim() || "their latest posts"}

Report what the posts actually say, most relevant first, up to 12 posts. For each: @handle, date, what they said in a sentence (quote the key words exactly), the numbers they gave, and the post's link. Then, in two short lines: the overall read (positive, negative or mixed, and what's driving it), and the most credible post that disagrees. Only report what's in the posts, never your own view. If you found little, say so plainly.`;
}

function grokTool({ fromDate, toDate }: XSearch, handles: string[]): Record<string, unknown> {
  return {
    type: "x_search",
    ...(handles.length ? { allowed_x_handles: handles } : {}),
    ...(fromDate ? { from_date: fromDate } : {}),
    ...(toDate ? { to_date: toDate } : {}),
  };
}

/**
 * Searches X: through X's API if Mach1 has an app for it, else through Grok
 * (also when X's API is down). `saved` holds the handles saved as high
 * signal, which are marked in the results.
 */
export async function searchX(organizationId: string, search: XSearch, saved: Set<string> = new Set()): Promise<string> {
  const handles = [...new Set((search.handles ?? []).map(cleanHandle).filter(Boolean))];
  if (!search.query?.trim() && !handles.length) return "Give search terms, or the accounts whose latest posts you want.";
  const api = xApi();
  let problem: string | null = null;
  if (api) {
    try {
      return await viaApi(api, search, handles, saved);
    } catch (error) {
      problem = apiProblem(error, xQuery(search, handles.slice(0, HANDLES_PER_SEARCH)));
      if (error instanceof ApiError && error.status === 400) return problem!;
    }
  }
  const apiKey = await xaiKey(organizationId);
  if (!apiKey) return problem ?? `X search ${api ? NO_XAI_KEY : NOT_SET_UP} Use web_search instead.`;
  const groups = batches(handles);
  const results = await Promise.all(groups.map((batch) => grokSearch(apiKey, grokTool(search, batch), grokPrompt(search, batch))));
  const found = results.length === 1 ? results[0] : results.map((r, i) => `From ${groups[i].map((h) => `@${h}`).join(", ")}:\n${r}`).join("\n\n");
  return `${problem ? `(${problem} Searched through Grok instead.)\n\n` : ""}${found}`;
}
