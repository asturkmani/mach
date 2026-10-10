// The sources people trust most for research: a website, an X account, a
// subreddit or a Reddit user, each with why it's worth reading. Saved from a
// screen or from chat ("save @DeItaone as high signal for macro"), they're
// looked at first and weighed higher by whoever researches for that person.
// Plain functions, so prompts, tools and screens can all use them; the
// database side is in store.ts.

export const SOURCE_KINDS = ["website", "x_account", "subreddit", "reddit_user"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type ResearchSource = {
  id: string;
  kind: SourceKind;
  /** ft.com, DeItaone, investing, someone: no @, r/ or u/. */
  handle: string;
  /** Why it's worth reading, in their words. */
  note: string;
  /** Private to whoever saved it, or the company's, for everyone's research. */
  visibility: "company" | "private";
  ownerPersonId: string | null;
  createdAt: Date;
};

export class SourceError extends Error {}

export const KIND_WORDS: Record<SourceKind, { one: string; many: string }> = {
  website: { one: "website", many: "Websites" },
  x_account: { one: "X account", many: "X accounts" },
  subreddit: { one: "subreddit", many: "Subreddits" },
  reddit_user: { one: "Reddit user", many: "Reddit users" },
};

const PATTERNS: Record<SourceKind, { test: RegExp; example: string }> = {
  website: { test: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, example: "ft.com" },
  x_account: { test: /^[A-Za-z0-9_]{1,15}$/, example: "@DeItaone or x.com/DeItaone" },
  subreddit: { test: /^[A-Za-z0-9_]{2,21}$/, example: "r/investing" },
  reddit_user: { test: /^[A-Za-z0-9_-]{3,20}$/, example: "u/someone" },
};

/** How a source reads to people: ft.com, @DeItaone, r/investing, u/someone. */
export function sourceLabel({ kind, handle }: Pick<ResearchSource, "kind" | "handle">): string {
  return kind === "x_account" ? `@${handle}` : kind === "subreddit" ? `r/${handle}` : kind === "reddit_user" ? `u/${handle}` : handle;
}

export function sourceUrl({ kind, handle }: Pick<ResearchSource, "kind" | "handle">): string {
  if (kind === "x_account") return `https://x.com/${handle}`;
  if (kind === "subreddit") return `https://www.reddit.com/r/${handle}`;
  if (kind === "reddit_user") return `https://www.reddit.com/user/${handle}`;
  return `https://${handle}`;
}

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const X_PAGES = new Set(["home", "search", "explore", "i", "hashtag", "intent", "share", "settings", "notifications", "messages"]);

function checked(kind: SourceKind, handle: string): { kind: SourceKind; handle: string } {
  const clean = kind === "website" ? handle.toLowerCase() : handle;
  if (!PATTERNS[kind].test.test(clean)) {
    throw new SourceError(`${handle || "That"} isn't ${kind === "x_account" ? "an" : "a"} ${KIND_WORDS[kind].one} I can follow. Give it like ${PATTERNS[kind].example}.`);
  }
  return { kind, handle: clean };
}

/**
 * Reads a source the way people give it: a link (x.com/DeItaone,
 * reddit.com/r/investing, https://www.ft.com/markets), @handle, r/name,
 * u/name or a domain. A bare name needs its kind.
 */
export function parseSource(input: string, kind?: SourceKind): { kind: SourceKind; handle: string } {
  const text = input.trim().replace(/[/?#]+$/, "");
  if (!text) throw new SourceError("Give the source: a website, @handle, r/subreddit or u/user.");

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || (!/\s/.test(text) && /^[^@/][^/]*\.[a-z]{2,}(\/|$)/i.test(text))) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw new SourceError(`${text} isn't a link I can read.`);
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m|old|new|np)\./, "");
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (X_HOSTS.has(host) && first && !X_PAGES.has(first.toLowerCase())) return checked("x_account", first.replace(/^@/, ""));
    if (host === "reddit.com" && /^r$/i.test(first ?? "") && second) return checked("subreddit", second);
    if (host === "reddit.com" && /^(u|user)$/i.test(first ?? "") && second) return checked("reddit_user", second);
    return checked("website", host);
  }
  if (text.startsWith("@")) return checked("x_account", text.slice(1));
  const prefixed = text.match(/^\/?(r|u|user)\/(.+)$/i);
  if (prefixed) return checked(prefixed[1].toLowerCase() === "r" ? "subreddit" : "reddit_user", prefixed[2]);
  if (kind) return checked(kind, text);
  if (/\./.test(text)) return checked("website", text);
  throw new SourceError(`Is ${text} a website, an X account, a subreddit or a Reddit user? Give it like @${text}, r/${text} or u/${text}.`);
}

/**
 * The sources for a researcher's instructions, grouped by kind with their
 * notes: the ones saved by the person the work is for, then the company's.
 */
export function sourcesBrief(sources: Pick<ResearchSource, "kind" | "handle" | "note" | "visibility">[], forName?: string, max = 60): string {
  if (!sources.length) return "";
  const shown = sources.slice(0, max);
  const groups = SOURCE_KINDS.map((kind) => {
    const lines = shown
      .filter((s) => s.kind === kind)
      .map((s) => `- ${sourceLabel(s)}${s.note ? `: ${s.note}` : ""}${s.visibility === "company" ? " (the company's)" : ""}`);
    return lines.length ? `${KIND_WORDS[kind].many}:\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  const more = sources.length > shown.length ? `\n…and ${sources.length - shown.length} more.` : "";
  return `<high_signal_sources>
The sources ${forName ? `${forName} trusts` : "the company trusts"} most for research. Look at them first (web_search with source_policy.include_domains set to the websites, x_search and reddit_search with saved_only), weigh what they say above other sources, and say when a finding comes from one. Then look wider: they're where to start, not the only places to look.
${groups.join("\n")}${more}
</high_signal_sources>`;
}
