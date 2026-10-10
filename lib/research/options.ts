// The choices the research tools take, shared by the tools (which run inside
// agent workflows, so this file imports nothing) and the code behind them.

export const MARKET_ACTIONS = ["quote", "profile", "history", "financials", "news", "holders", "analysts", "search"] as const;
export type MarketAction = (typeof MARKET_ACTIONS)[number];

export const PERIODS = ["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"] as const;
export type Period = (typeof PERIODS)[number];

export const STATEMENTS = ["income", "balance", "cashflow"] as const;
export type Statement = (typeof STATEMENTS)[number];

export const REDDIT_TIMES = ["day", "week", "month", "year", "all"] as const;
export const REDDIT_SORTS = ["relevance", "top", "new", "comments"] as const;
