import "server-only";

import type { REDDIT_SORTS, REDDIT_TIMES } from "@/lib/research/options";
import { grokSearch, NO_XAI_KEY, xaiKey } from "@/lib/research/grok";

// Searching Reddit without anyone signing in. Reddit closed its open JSON to
// servers in 2026 and approves API apps one by one, so there are two ways:
// with Mach1's own Reddit app (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET, an
// app-only token), posts come with their scores and top comments; without
// one, Grok searches reddit.com on the web and reports the threads it finds.

export type RedditSearch = {
  query: string;
  subreddits?: string[];
  users?: string[];
  time?: (typeof REDDIT_TIMES)[number];
  sort?: (typeof REDDIT_SORTS)[number];
};

let testFetch: typeof fetch | null = null;
/** Tests answer for Reddit. */
export function setRedditFetch(next: typeof fetch | null): void {
  testFetch = next;
  token = null;
}
const http = (...args: Parameters<typeof fetch>) => (testFetch ?? fetch)(...args);

const userAgent = () => process.env.REDDIT_USER_AGENT || "web:mach1-research:1.0";

let token: { value: string; expires: number } | null = null;

/** Mach1's app-only Reddit token, or null when there's no Reddit app (or Reddit refused it). */
async function redditToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && token.expires > Date.now() + 60_000) return token.value;
  try {
    const response = await http("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent(),
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`Reddit refused Mach1's app token (${response.status})`);
      return null;
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return token.value;
  } catch (error) {
    console.error("Couldn't reach Reddit for a token", (error as Error).message);
    return null;
  }
}

type Listing<T> = { data?: { children?: { kind?: string; data: T }[] } };
type Post = {
  id: string;
  subreddit: string;
  title: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
  permalink: string;
  url?: string;
  selftext?: string;
  stickied?: boolean;
};
type Comment = { author?: string; body?: string; score?: number; stickied?: boolean };

async function api<T>(accessToken: string, path: string, query: Record<string, string>): Promise<T> {
  const response = await http(`https://oauth.reddit.com${path}?${new URLSearchParams({ ...query, raw_json: "1" })}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": userAgent() },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Reddit answered ${response.status}`);
  return (await response.json()) as T;
}

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const excerpt = (text = "", max = 300) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

async function viaApi(accessToken: string, search: RedditSearch): Promise<string> {
  const query = { sort: search.sort ?? "relevance", t: search.time ?? "month", limit: "12", type: "link" };
  const subs = search.subreddits ?? [];
  const searches: Promise<Listing<Post>>[] = [];
  if (subs.length || !search.users?.length) {
    searches.push(api(accessToken, subs.length ? `/r/${subs.join("+")}/search` : "/search", { ...query, q: search.query, ...(subs.length ? { restrict_sr: "1" } : {}) }));
  }
  for (const user of search.users ?? []) searches.push(api(accessToken, "/search", { ...query, q: `${search.query} author:${user}` }));
  const seen = new Set<string>();
  const posts = (await Promise.all(searches))
    .flatMap((listing) => listing.data?.children?.map((c) => c.data) ?? [])
    .filter((p) => !p.stickied && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 15);
  if (!posts.length) return `Nothing on Reddit for "${search.query}"${subs.length ? ` in ${subs.map((s) => `r/${s}`).join(", ")}` : ""} in the last ${search.time ?? "month"}.`;

  // What people say under the three most-upvoted threads.
  const discussed = [...posts].filter((p) => p.num_comments > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  const comments = new Map<string, Comment[]>();
  await Promise.all(
    discussed.map(async (p) => {
      try {
        const [, thread] = await api<[unknown, Listing<Comment>]>(accessToken, `/comments/${p.id}`, { sort: "top", limit: "8", depth: "1" });
        comments.set(
          p.id,
          (thread.data?.children ?? [])
            .filter((c) => c.kind === "t1" && !c.data.stickied && c.data.author !== "AutoModerator" && c.data.body)
            .map((c) => c.data)
            .slice(0, 4),
        );
      } catch {
        // The post still counts without its comments.
      }
    }),
  );
  return `Reddit, "${search.query}", last ${search.time ?? "month"}, by ${search.sort ?? "relevance"}:\n\n${posts
    .map((p) =>
      [
        `- r/${p.subreddit} · ${p.score} points · ${p.num_comments} comments · ${day(p.created_utc)} · u/${p.author}: ${p.title}`,
        p.selftext ? `  ${excerpt(p.selftext)}` : "",
        `  https://www.reddit.com${p.permalink}`,
        ...(comments.get(p.id) ?? []).map((c) => `  > ${c.score ?? "?"} points, u/${c.author}: ${excerpt(c.body, 220)}`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")}`;
}

function grokPrompt(search: RedditSearch): string {
  const where = [
    search.subreddits?.length ? `only threads in ${search.subreddits.map((s) => `r/${s}`).join(", ")}` : "",
    search.users?.length ? `only posts or comments by ${search.users.map((u) => `u/${u}`).join(", ")}` : "",
    search.time && search.time !== "all" ? `from the last ${search.time}` : "",
  ].filter(Boolean);
  return `Search Reddit (reddit.com) for: ${search.query}${where.length ? `\nLook at ${where.join("; ")}.` : ""}

Report up to 10 threads, most relevant first. For each: the subreddit, title, date, upvotes and comment count if shown, what the post and its top comments say (quote the key words exactly, with any numbers), and the thread's link. Then, in two short lines: the overall read on Reddit (positive, negative or mixed, and why) and the strongest disagreement. Only report what's in the threads, never your own view. If you found little, say so plainly.`;
}

/** Searches Reddit with Mach1's Reddit app if it has one, else through Grok's web search. */
export async function searchReddit(organizationId: string, search: RedditSearch): Promise<string> {
  const accessToken = await redditToken();
  if (accessToken) {
    try {
      return await viaApi(accessToken, search);
    } catch (error) {
      console.error("Reddit search failed; trying Grok's web search", (error as Error).message);
    }
  }
  const apiKey = await xaiKey(organizationId);
  if (!apiKey) return `Reddit search ${NO_XAI_KEY} Use web_search with source_policy.include_domains ["reddit.com"] instead.`;
  const found = await grokSearch(apiKey, { type: "web_search", allowed_domains: ["reddit.com"] }, grokPrompt(search), "Reddit search");
  return `Reddit (found through web search: scores and dates may be missing; read a thread with fetch_page for more):\n\n${found}`;
}
