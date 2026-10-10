import "server-only";

import YahooFinance from "yahoo-finance2";

import type { Period, Statement } from "@/lib/research/options";

// Market data from Yahoo Finance (yahoo-finance2): quotes, company profiles
// and key numbers, price history, financial statements, news, holders and
// analysts. Free and needs no account; it's delayed and unofficial, so
// figures carry their source and as-of time, and anything that matters is
// checked against filings. Answers are short text for a model to read: the
// handful of numbers that matter, not Yahoo's whole response.

// Yahoo's responses drift; read them loosely rather than fail on a new field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

export type MarketClient = {
  quote(symbols: string[]): Promise<Loose[]>;
  quoteSummary(symbol: string, modules: string[]): Promise<Loose>;
  chart(symbol: string, options: { period1: Date; interval: Interval }): Promise<{ meta?: Loose; quotes: Loose[] }>;
  fundamentals(symbol: string, options: { module: "financials" | "balance-sheet" | "cash-flow"; type: "annual" | "quarterly"; period1: Date }): Promise<Loose[]>;
  search(query: string, options: { quotesCount: number; newsCount: number }): Promise<{ quotes?: Loose[]; news?: Loose[] }>;
};

type Interval = "1d" | "1wk" | "1mo";

const loose = { validateResult: false } as const;

function yahooClient(): MarketClient {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  return {
    quote: async (symbols) => [(await yf.quote(symbols, {}, loose)) ?? []].flat(),
    quoteSummary: async (symbol, modules) => ((await yf.quoteSummary(symbol, { modules: modules as never }, loose)) ?? {}) as Loose,
    chart: async (symbol, options) => ((await yf.chart(symbol, options, loose)) ?? { quotes: [] }) as { meta?: Loose; quotes: Loose[] },
    fundamentals: async (symbol, options) => (await yf.fundamentalsTimeSeries(symbol, options, loose)) ?? [],
    search: async (query, options) => ((await yf.search(query, options, loose)) ?? {}) as { quotes?: Loose[]; news?: Loose[] },
  };
}

let client: MarketClient | null = null;
/** Tests swap in canned data. */
export function setMarketClient(next: MarketClient | null): void {
  client = next;
}
const yahoo = () => (client ??= yahooClient());

// ---- Numbers as people read them --------------------------------------------

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Yahoo sometimes wraps numbers as { raw, fmt }. */
const val = (v: unknown): number | undefined => (isNum(v) ? v : isNum((v as Loose)?.raw) ? (v as Loose).raw : undefined);

export function big(v: unknown): string {
  const n = val(v);
  if (n === undefined) return "n/a";
  const abs = Math.abs(n);
  for (const [unit, size] of [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    if (abs >= size) return `${(n / size).toFixed(abs / size >= 100 ? 0 : abs / size >= 10 ? 1 : 2)}${unit}`;
  }
  return n.toFixed(abs < 10 ? 2 : 0);
}
export const num = (v: unknown, digits = 2) => (val(v) === undefined ? "n/a" : val(v)!.toFixed(digits));
/** A fraction (0.123) as a percent. */
export const pct = (v: unknown) => (val(v) === undefined ? "n/a" : `${(val(v)! * 100).toFixed(1)}%`);
const date = (v: unknown) => {
  const d = v instanceof Date ? v : isNum(v) ? new Date(v < 1e12 ? v * 1000 : v) : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "n/a";
};
const line = (label: string, value: string) => (value === "n/a" || value === "n/a%" ? "" : `${label}: ${value}`);
const lines = (...parts: string[]) => parts.filter(Boolean).join("\n");

// ---- Actions ----------------------------------------------------------------

export async function quotes(symbols: string[]): Promise<string> {
  const found = await yahoo().quote(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20));
  if (!found.length) return `Yahoo Finance has no quote for ${symbols.join(", ")}. Look the symbol up with action search.`;
  return found
    .map((q) =>
      lines(
        `${q.symbol} · ${q.longName ?? q.shortName ?? ""} (${q.fullExchangeName ?? q.exchange ?? "?"}, ${q.currency ?? "?"})`,
        `Price ${num(q.regularMarketPrice)} (${num(q.regularMarketChangePercent)}% on the day), ${q.marketState ?? ""} as of ${q.regularMarketTime ? new Date(q.regularMarketTime).toISOString().slice(0, 16).replace("T", " ") : "n/a"} UTC`,
        [line("Market cap", big(q.marketCap)), line("P/E", num(q.trailingPE)), line("Forward P/E", num(q.forwardPE)), line("Dividend yield", isNum(q.dividendYield) ? `${num(q.dividendYield)}%` : "n/a")]
          .filter(Boolean)
          .join(" · "),
        isNum(q.fiftyTwoWeekLow) ? `52 weeks: ${num(q.fiftyTwoWeekLow)} to ${num(q.fiftyTwoWeekHigh)}` : "",
      ),
    )
    .join("\n\n");
}

export async function profile(symbol: string): Promise<string> {
  const s = await yahoo().quoteSummary(symbol.toUpperCase(), [
    "price",
    "summaryProfile",
    "summaryDetail",
    "defaultKeyStatistics",
    "financialData",
    "calendarEvents",
  ]);
  const p = s.price ?? {};
  const prof = s.summaryProfile ?? {};
  const d = s.summaryDetail ?? {};
  const k = s.defaultKeyStatistics ?? {};
  const f = s.financialData ?? {};
  const earnings = (s.calendarEvents?.earnings?.earningsDate ?? []) as unknown[];
  const about = String(prof.longBusinessSummary ?? "");
  return lines(
    `${p.symbol ?? symbol.toUpperCase()} · ${p.longName ?? p.shortName ?? ""} (${p.exchangeName ?? "?"}, ${p.currency ?? "?"})`,
    [prof.sector, prof.industry, prof.country, isNum(prof.fullTimeEmployees) ? `${big(prof.fullTimeEmployees)} staff` : "", prof.website].filter(Boolean).join(" · "),
    about ? `About: ${about.length > 900 ? `${about.slice(0, 900)}…` : about}` : "",
    "",
    "Valuation: " +
      [
        line("price", num(p.regularMarketPrice)),
        line("market cap", big(p.marketCap ?? d.marketCap)),
        line("EV", big(k.enterpriseValue)),
        line("P/E", num(d.trailingPE)),
        line("forward P/E", num(k.forwardPE ?? d.forwardPE)),
        line("EV/EBITDA", num(k.enterpriseToEbitda)),
        line("P/B", num(k.priceToBook)),
        line("dividend yield", pct(d.dividendYield)),
        line("beta", num(d.beta)),
      ]
        .filter(Boolean)
        .join(", "),
    "Operations (trailing twelve months): " +
      [
        line("revenue", big(f.totalRevenue)),
        line("growth", pct(f.revenueGrowth)),
        line("gross margin", pct(f.grossMargins)),
        line("operating margin", pct(f.operatingMargins)),
        line("net margin", pct(f.profitMargins)),
        line("EBITDA", big(f.ebitda)),
        line("free cash flow", big(f.freeCashflow)),
        line("ROE", pct(f.returnOnEquity)),
      ]
        .filter(Boolean)
        .join(", "),
    "Balance sheet: " +
      [line("cash", big(f.totalCash)), line("debt", big(f.totalDebt)), line("debt/equity", num(f.debtToEquity)), line("shares out", big(k.sharesOutstanding))]
        .filter(Boolean)
        .join(", "),
    "Ownership: " +
      [line("insiders", pct(k.heldPercentInsiders)), line("institutions", pct(k.heldPercentInstitutions)), line("short % of float", pct(k.shortPercentOfFloat))]
        .filter(Boolean)
        .join(", "),
    isNum(val(f.targetMeanPrice))
      ? `Analysts: ${f.recommendationKey ?? "?"} from ${f.numberOfAnalystOpinions ?? "?"}; target ${num(f.targetMeanPrice)} (${num(f.targetLowPrice)} to ${num(f.targetHighPrice)})`
      : "",
    earnings.length ? `Next earnings: ${earnings.map(date).join(" to ")}` : "",
    "Source: Yahoo Finance (delayed, unofficial).",
  );
}

function periodStart(period: Period, now = new Date()): Date {
  const d = new Date(now);
  if (period === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  if (period === "max") return new Date("1970-01-02");
  const [n, unit] = [parseInt(period, 10), period.replace(/\d+/, "")];
  if (unit === "mo") d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

/** Price history: the move, range, volatility and drawdown, then the closes (daily up to a year, weekly to five, monthly beyond). */
export async function history(symbol: string, period: Period = "1y"): Promise<string> {
  const interval: Interval = ["1mo", "3mo", "6mo", "ytd", "1y"].includes(period) ? "1d" : ["2y", "5y"].includes(period) ? "1wk" : "1mo";
  const chart = await yahoo().chart(symbol.toUpperCase(), { period1: periodStart(period), interval });
  const rows = chart.quotes.filter((q) => isNum(val(q.adjclose ?? q.close)));
  if (rows.length < 2) return `No price history for ${symbol.toUpperCase()} over ${period}.`;
  const close = (q: Loose) => val(q.adjclose ?? q.close)!;
  const first = rows[0];
  const last = rows.at(-1)!;
  const high = rows.reduce((a, b) => (close(b) > close(a) ? b : a));
  const low = rows.reduce((a, b) => (close(b) < close(a) ? b : a));
  let peak = close(first);
  let drawdown = 0;
  for (const q of rows) {
    peak = Math.max(peak, close(q));
    drawdown = Math.min(drawdown, close(q) / peak - 1);
  }
  const returns = rows.slice(1).map((q, i) => Math.log(close(q) / close(rows[i])));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1));
  const perYear = interval === "1d" ? 252 : interval === "1wk" ? 52 : 12;
  // Long histories are thinned to about 130 rows; the stats above use them all.
  const step = Math.max(1, Math.ceil(rows.length / 130));
  const shown = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  return lines(
    `${symbol.toUpperCase()} over ${period} (${interval === "1d" ? "daily" : interval === "1wk" ? "weekly" : "monthly"}, adjusted closes, ${chart.meta?.currency ?? ""}):`,
    `${date(first.date)} ${num(close(first))} → ${date(last.date)} ${num(close(last))}: ${((close(last) / close(first) - 1) * 100).toFixed(1)}%`,
    `High ${num(close(high))} on ${date(high.date)}, low ${num(close(low))} on ${date(low.date)}, max drawdown ${(drawdown * 100).toFixed(1)}%, annualised volatility ${(sd * Math.sqrt(perYear) * 100).toFixed(1)}%`,
    `date,close,volume${step > 1 ? ` (one row in ${step})` : ""}`,
    ...shown.map((q) => `${date(q.date)},${num(close(q))},${isNum(q.volume) ? q.volume : ""}`),
    "Source: Yahoo Finance.",
  );
}

const STATEMENT_LINES: Record<Statement, { module: "financials" | "balance-sheet" | "cash-flow"; rows: readonly (readonly [string, string])[] }> = {
  income: {
    module: "financials",
    rows: [
      ["totalRevenue", "Revenue"],
      ["grossProfit", "Gross profit"],
      ["operatingIncome", "Operating income"],
      ["EBITDA", "EBITDA"],
      ["netIncomeCommonStockholders", "Net income"],
      ["dilutedEPS", "Diluted EPS"],
      ["dilutedAverageShares", "Diluted shares"],
    ],
  },
  balance: {
    module: "balance-sheet",
    rows: [
      ["totalAssets", "Total assets"],
      ["cashCashEquivalentsAndShortTermInvestments", "Cash and short-term investments"],
      ["totalDebt", "Total debt"],
      ["netDebt", "Net debt"],
      ["totalLiabilitiesNetMinorityInterest", "Total liabilities"],
      ["stockholdersEquity", "Shareholders' equity"],
      ["workingCapital", "Working capital"],
    ],
  },
  cashflow: {
    module: "cash-flow",
    rows: [
      ["operatingCashFlow", "Operating cash flow"],
      ["capitalExpenditure", "Capex"],
      ["freeCashFlow", "Free cash flow"],
      ["repurchaseOfCapitalStock", "Buybacks"],
      ["cashDividendsPaid", "Dividends paid"],
      ["stockBasedCompensation", "Stock-based compensation"],
    ],
  },
};

/** A financial statement's main lines, one column per period, oldest first. */
export async function financials(symbol: string, statement: Statement = "income", frequency: "annual" | "quarterly" = "annual"): Promise<string> {
  const { module, rows } = STATEMENT_LINES[statement];
  const period1 = new Date();
  period1.setUTCFullYear(period1.getUTCFullYear() - (frequency === "annual" ? 5 : 2));
  const periods = (await yahoo().fundamentals(symbol.toUpperCase(), { module, type: frequency, period1 }))
    .filter((p) => p.date)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date))
    .filter((p) => rows.some(([key]) => isNum(p[key])))
    .slice(frequency === "annual" ? -5 : -8);
  if (!periods.length) return `No ${statement} statement for ${symbol.toUpperCase()} on Yahoo Finance. Try the company's filings.`;
  const table = rows
    .filter(([key]) => periods.some((p) => isNum(p[key])))
    .map(([key, label]) => `${label},${periods.map((p) => (key === "dilutedEPS" ? num(p[key]) : big(p[key]))).join(",")}`);
  return lines(
    `${symbol.toUpperCase()} ${statement === "income" ? "income statement" : statement === "balance" ? "balance sheet" : "cash flow"}, ${frequency}, periods ending:`,
    `Line,${periods.map((p) => date(p.date)).join(",")}`,
    ...table,
    "Source: Yahoo Finance (from filings; check the filing itself for anything that matters).",
  );
}

/** Recent headlines for a symbol (or any search), the ones tagged with that symbol first. */
export async function news(query: string): Promise<string> {
  const found = await yahoo().search(query, { quotesCount: 0, newsCount: 20 });
  const symbol = query.trim().toUpperCase();
  const all = found.news ?? [];
  const tagged = all.filter((n) => ((n.relatedTickers ?? []) as string[]).some((t) => t.toUpperCase() === symbol));
  const items = (tagged.length ? tagged : all).slice(0, 10);
  if (!items.length) return `No recent news on Yahoo Finance for ${query}.`;
  return items.map((n) => `- ${date(n.providerPublishTime)} · ${n.publisher ?? "?"}: ${n.title} ${n.link ?? ""}`).join("\n");
}

export async function lookup(query: string): Promise<string> {
  const found = await yahoo().search(query, { quotesCount: 8, newsCount: 0 });
  const items = (found.quotes ?? []).filter((q) => q.symbol);
  if (!items.length) return `No symbol found for ${query}.`;
  return items.map((q) => `- ${q.symbol}: ${q.longname ?? q.shortname ?? ""} (${q.quoteType ?? q.typeDisp ?? "?"}, ${q.exchDisp ?? q.exchange ?? "?"})`).join("\n");
}

export async function holders(symbol: string): Promise<string> {
  const s = await yahoo().quoteSummary(symbol.toUpperCase(), ["majorHoldersBreakdown", "institutionOwnership", "insiderTransactions"]);
  const m = s.majorHoldersBreakdown ?? {};
  const institutions = (s.institutionOwnership?.ownershipList ?? []) as Loose[];
  const insiders = (s.insiderTransactions?.transactions ?? []) as Loose[];
  return lines(
    `${symbol.toUpperCase()} holders:`,
    [line("insiders", pct(m.insidersPercentHeld)), line("institutions", pct(m.institutionsPercentHeld)), line("institutions holding", num(m.institutionsCount, 0))]
      .filter(Boolean)
      .join(", "),
    institutions.length ? "Largest institutions (as of their last filing):" : "",
    ...institutions.slice(0, 10).map((i) => `- ${i.organization}: ${pct(i.pctHeld)} (${big(i.position)} shares, ${big(i.value)}), reported ${date(i.reportDate)}`),
    insiders.length ? "Latest insider transactions:" : "",
    ...insiders.slice(0, 10).map((t) => `- ${date(t.startDate)} ${t.filerName} (${t.filerRelation ?? "?"}): ${t.transactionText || "transaction"}${isNum(val(t.shares)) ? `, ${big(t.shares)} shares` : ""}${isNum(val(t.value)) ? `, ${big(t.value)}` : ""}`),
    "Source: Yahoo Finance.",
  );
}

const GRADE_ACTIONS: Record<string, string> = { up: "upgraded", down: "downgraded", init: "started", main: "kept", reit: "kept" };

export async function analysts(symbol: string): Promise<string> {
  const s = await yahoo().quoteSummary(symbol.toUpperCase(), ["recommendationTrend", "upgradeDowngradeHistory", "financialData", "earningsTrend"]);
  const trend = ((s.recommendationTrend?.trend ?? []) as Loose[]).slice(0, 3);
  const changes = ((s.upgradeDowngradeHistory?.history ?? []) as Loose[]).slice(0, 12);
  const f = s.financialData ?? {};
  const estimates = ((s.earningsTrend?.trend ?? []) as Loose[]).filter((t) => ["0q", "+1q", "0y", "+1y"].includes(t.period));
  return lines(
    `${symbol.toUpperCase()} analysts:`,
    isNum(val(f.targetMeanPrice)) ? `Price target ${num(f.targetMeanPrice)} mean (${num(f.targetLowPrice)} to ${num(f.targetHighPrice)}) from ${f.numberOfAnalystOpinions ?? "?"}, vs ${num(f.currentPrice)} now; consensus ${f.recommendationKey ?? "?"}` : "",
    ...trend.map((t) => `Ratings ${t.period === "0m" ? "now" : t.period === "-1m" ? "a month ago" : `${String(t.period).replace(/[-m]/g, "")} months ago`}: ${t.strongBuy} strong buy, ${t.buy} buy, ${t.hold} hold, ${t.sell} sell, ${t.strongSell} strong sell`),
    ...estimates.map(
      (t) =>
        `Estimate ${t.period} (to ${date(t.endDate)}): EPS ${num(t.earningsEstimate?.avg)} (${t.earningsEstimate?.numberOfAnalysts ?? "?"} analysts), revenue ${big(t.revenueEstimate?.avg)}, growth ${pct(t.growth)}`,
    ),
    changes.length ? "Latest rating changes:" : "",
    ...changes.map(
      (c) =>
        `- ${date(c.epochGradeDate)} ${c.firm}: ${c.toGrade} (${GRADE_ACTIONS[c.action] ?? c.action}${c.fromGrade && c.fromGrade !== c.toGrade ? ` from ${c.fromGrade}` : ""})`,
    ),
    "Source: Yahoo Finance.",
  );
}
