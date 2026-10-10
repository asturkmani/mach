import type { AgentContext } from "@/lib/agents/prompts";
import { analysts, financials, history, holders, lookup, news, profile, quotes } from "@/lib/research/market";
import type { MarketAction, Period, Statement } from "@/lib/research/options";
import { searchReddit, type RedditSearch } from "@/lib/research/reddit";
import { listSources } from "@/lib/research/store";
import { searchX, type XSearch } from "@/lib/research/x";

// The research tools' work (tools.ts), each a durable workflow step when an
// agent runs on a task, and a plain call for the Chief of Staff and
// specialists. Each returns text for the model, never throws for a
// problem the model can work around.

export type MarketInput = {
  action: MarketAction;
  symbols?: string[];
  query?: string;
  period?: Period;
  statement?: Statement;
  frequency?: "annual" | "quarterly";
};

export async function marketData(_context: AgentContext, input: MarketInput): Promise<string> {
  "use step";
  const symbol = input.symbols?.[0]?.trim();
  const needs = (what: string) => `Give ${what} for ${input.action}.`;
  try {
    switch (input.action) {
      case "quote":
        return input.symbols?.length ? await quotes(input.symbols) : needs("symbols");
      case "search":
        return input.query || symbol ? await lookup(input.query || symbol!) : needs("a query (a company name)");
      case "news":
        return input.query || symbol ? await news(symbol || input.query!) : needs("a symbol or a query");
      case "profile":
        return symbol ? await profile(symbol) : needs("a symbol");
      case "history":
        return symbol ? await history(symbol, input.period) : needs("a symbol");
      case "financials":
        return symbol ? await financials(symbol, input.statement, input.frequency) : needs("a symbol");
      case "holders":
        return symbol ? await holders(symbol) : needs("a symbol");
      case "analysts":
        return symbol ? await analysts(symbol) : needs("a symbol");
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/not found|no data|invalid|delisted/i.test(message)) {
      return `Yahoo Finance has nothing for ${symbol ?? input.query}. Check the symbol with action search (London listings end .L, e.g. RR.L).`;
    }
    console.error(`Yahoo Finance ${input.action} failed`, message);
    return `Yahoo Finance couldn't answer just now (${message.slice(0, 160)}). Try again shortly, or use web_search.`;
  }
}

export async function xSearch(context: AgentContext, input: XSearch & { savedOnly?: boolean }): Promise<string> {
  "use step";
  let handles = input.handles ?? [];
  if (input.savedOnly) {
    const saved = (await listSources(context.organizationId, { viewer: context.personId ?? null })).filter((s) => s.kind === "x_account");
    if (!saved.length) return "No X accounts are saved as high signal yet. Search without saved_only, or ask them which accounts they trust.";
    handles = [...handles, ...saved.map((s) => s.handle)];
  }
  try {
    return await searchX(context.organizationId, { ...input, handles });
  } catch (error) {
    console.error("X search failed", error);
    return "X search failed. Try again, or use web_search.";
  }
}

export async function redditSearch(context: AgentContext, input: RedditSearch & { savedOnly?: boolean }): Promise<string> {
  "use step";
  let { subreddits = [], users = [] } = input;
  if (input.savedOnly) {
    const saved = await listSources(context.organizationId, { viewer: context.personId ?? null });
    subreddits = [...subreddits, ...saved.filter((s) => s.kind === "subreddit").map((s) => s.handle)];
    users = [...users, ...saved.filter((s) => s.kind === "reddit_user").map((s) => s.handle)].slice(0, 5);
    if (!subreddits.length && !users.length) return "No subreddits or Reddit users are saved as high signal yet. Search without saved_only.";
  }
  const clean = (names: string[]) => [...new Set(names.map((n) => n.trim().replace(/^\/?(r|u|user)\//i, "")).filter(Boolean))];
  try {
    return await searchReddit(context.organizationId, { ...input, subreddits: clean(subreddits), users: clean(users) });
  } catch (error) {
    console.error("Reddit search failed", error);
    return "Reddit search failed. Try again, or use web_search with source_policy.include_domains [\"reddit.com\"].";
  }
}
