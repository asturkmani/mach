import { gateway, tool, type ToolSet } from "ai";
import { z } from "zod";

import type { AgentContext } from "@/lib/agents/prompts";
import { MARKET_ACTIONS, PERIODS, REDDIT_SORTS, REDDIT_TIMES, STATEMENTS } from "@/lib/research/options";
import { marketData, redditSearch, xSearch } from "@/lib/research/steps";

// The research tools beyond web search: market data (Yahoo Finance), X and
// Reddit, each able to look only at the sources people saved as high signal.
// Every agent has them, the Chief of Staff too. In-depth research is a job:
// its coordinator sends each question to a worker child, which comes back with
// compressed findings and numbered sources (the supervisor and researchers of
// LangChain's open_deep_research).

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function insightTools(context: AgentContext) {
  return {
    market_data: tool({
      description:
        "Market data from Yahoo Finance (free, delayed, unofficial): quote (prices for up to 20 symbols, also FX like GBPUSD=X, indices like ^GSPC, crypto like BTC-USD), profile (the business, valuation, margins, balance sheet, ownership, analysts' target), history (the move, drawdown, volatility and closes over a period), financials (income, balance or cashflow statement, annual or quarterly), news, holders (largest institutions, insider trades), analysts (ratings, targets, estimates, recent changes), search (find a symbol; London listings end .L, e.g. RR.L). Cite it as Yahoo Finance with its date, and check filings for anything that matters.",
      inputSchema: z.object({
        action: z.enum(MARKET_ACTIONS),
        symbols: z.array(z.string().min(1)).max(20).optional().describe("Ticker symbols, e.g. ['NVDA'] or ['AAPL', 'MSFT', 'GBPUSD=X']. One for every action but quote."),
        query: z.string().optional().describe("For search (a company name) or news on a topic."),
        period: z.enum(PERIODS).optional().describe("For history; default 1y."),
        statement: z.enum(STATEMENTS).optional().describe("For financials; default income."),
        frequency: z.enum(["annual", "quarterly"]).optional().describe("For financials; default annual."),
      }),
      execute: (input) => marketData(context, input),
    }),
    x_search: tool({
      description:
        "Search X (Twitter): what investors, analysts, founders and companies are saying, breaking news, sentiment. Returns the posts with their authors, engagement and links, most engaged first: the last 7 days, or from from_date back to 2006. saved_only looks only at the X accounts saved as high signal; handles names others; with no query you get those accounts' latest posts. Every post read costs money: one well-aimed search beats several.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Search terms, not a sentence: keywords, "exact phrases", OR, $cashtags, #hashtags, e.g. \'$MU (HBM OR guidance)\'. Leave out for the accounts\' latest posts.'),
        handles: z.array(z.string()).max(20).optional().describe("Only posts from these accounts, e.g. ['DeItaone']."),
        saved_only: z.boolean().optional().describe("Only the X accounts saved as high signal (with any handles given)."),
        from_date: day.optional().describe("YYYY-MM-DD. Older than a week searches X's archive."),
        to_date: day.optional(),
        sort: z.enum(["relevancy", "recency"]).optional().describe("Default relevancy; recency for the latest."),
        replies: z.boolean().optional().describe("Include replies (left out by default)."),
      }),
      execute: ({ saved_only, from_date, to_date, ...input }) => xSearch(context, { ...input, savedOnly: saved_only, fromDate: from_date, toDate: to_date }),
    }),
    reddit_search: tool({
      description:
        "Search Reddit: what retail investors and practitioners say, with the posts' scores and top comments where Reddit allows. saved_only looks only at the subreddits and Reddit users saved as high signal; subreddits or users name others.",
      inputSchema: z.object({
        query: z.string().min(1),
        subreddits: z.array(z.string()).max(10).optional().describe("e.g. ['investing', 'SecurityAnalysis'], without r/."),
        users: z.array(z.string()).max(5).optional().describe("Only posts by these users, without u/."),
        saved_only: z.boolean().optional(),
        time: z.enum(REDDIT_TIMES).optional().describe("Default month."),
        sort: z.enum(REDDIT_SORTS).optional().describe("Default relevance."),
      }),
      execute: ({ saved_only, ...input }) => redditSearch(context, { ...input, savedOnly: saved_only }),
    }),
  } satisfies ToolSet;
}

/**
 * The research skill's second web search: Exa, through AI Gateway (no key of our
 * own; about $7 per thousand searches). Where Parallel's web_search answers a
 * question from the web, Exa finds things by what they are: companies, people,
 * financial reports, news, research papers.
 */
export const exaTools = () =>
  ({
    exa_search: gateway.tools.exaSearch({ numResults: 8, contents: { highlights: { maxCharacters: 1200 } } }),
  }) satisfies ToolSet;
