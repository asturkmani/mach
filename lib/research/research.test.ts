import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import type { Actor } from "@/lib/operations";
import { linkMember } from "@/lib/people";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";

import { setMarketClient } from "./market";
import { setRedditFetch } from "./reddit";
import { listSources } from "./store";
import { insightTools } from "./tools";
import { setXaiFetch } from "./x";

const ORG = "org_cedar";

async function team() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
  const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
  const as = (person: { id: string; name: string }, isAdmin = false): Actor => ({
    organizationId: ORG,
    personId: person.id,
    name: person.name,
    userId: `user_${person.name.toLowerCase()}`,
    isAdmin,
  });
  return { sara: as(sara), omar: as(omar), omarAdmin: as(omar, true) };
}

type Run = (input: object) => Promise<string>;
function tools(personId?: string): Record<"market_data" | "x_search" | "reddit_search", Run> {
  const all = insightTools({ organizationId: ORG, taskId: null, agentId: null, agentName: "Chief of Staff", personId });
  return Object.fromEntries(
    Object.entries(all).map(([name, t]) => [name, (input: object) => (t.execute as (i: object, o: object) => Promise<string>)(input, { toolCallId: "t", messages: [] })]),
  ) as Record<"market_data" | "x_search" | "reddit_search", Run>;
}

/** A fetch that answers from a list and records what was asked. */
function recorder(answer: (url: string, body: Record<string, unknown> | null) => unknown) {
  const calls: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(answer(url, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const grokReply = (text: string, urls: string[] = []) => ({
  output: [
    { type: "x_search_call" },
    { type: "message", content: [{ type: "output_text", text, annotations: urls.map((url) => ({ type: "url_citation", url })) }] },
  ],
});

describe("high-signal sources", () => {
  beforeEach(useTestDb);

  it("are saved from chat, private to whoever saved them unless shared", async () => {
    const { sara, omar } = await team();
    expect(await doAction(sara, "source.add", { source: "https://x.com/DeItaone", note: "breaking macro" })).toBe(
      "Saved @DeItaone as a high-signal source for your research.",
    );
    expect(await doAction(sara, "source.add", { source: "r/SecurityAnalysis", shareWithCompany: true })).toBe(
      "Saved r/SecurityAnalysis as a high-signal source for the company's research.",
    );
    // Saving it again changes the note rather than adding it twice.
    expect(await doAction(sara, "source.add", { source: "@DeItaone", note: "fastest macro headlines" })).toContain("Updated @DeItaone");

    const listed = await doAction(sara, "source.list", {});
    expect(listed).toContain("@DeItaone (yours): fastest macro headlines");
    expect(listed).toContain("r/SecurityAnalysis (yours, shared with the company)");
    expect(listed).toContain("/research");
    expect((await listSources(ORG, { viewer: omar.personId })).map((s) => s.handle)).toEqual(["SecurityAnalysis"]);
    expect(await doAction(omar, "source.list", {})).toContain("r/SecurityAnalysis (the company's)");
  });

  it("are changed only by whoever saved them, or an admin for the company's", async () => {
    const { sara, omar, omarAdmin } = await team();
    await doAction(sara, "source.add", { source: "@DeItaone" });
    await doAction(sara, "source.add", { source: "ft.com", shareWithCompany: true });

    expect(await doAction(omar, "source.remove", { source: "@DeItaone" })).toContain("You have no saved source @DeItaone");
    expect(await doAction(omar, "source.remove", { source: "ft.com" })).toContain("only whoever saved it, or an admin");
    expect(await doAction(omarAdmin, "source.update", { source: "ft.com", note: "markets coverage" })).toBe("Saved ft.com.");
    expect(await doAction(sara, "source.update", { source: "ft.com", shareWithCompany: false })).toBe("ft.com is just yours now.");
    expect(await listSources(ORG, { viewer: omar.personId })).toEqual([]);
    expect(await doAction(sara, "source.remove", { source: "DeItaone" })).toBe("Removed @DeItaone from the saved sources.");
    expect(await doAction(sara, "source.add", { source: "investing" })).toContain("Is investing a website, an X account");
  });
});

describe("the research tools", () => {
  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("XAI_API_KEY", "xai-test");
    vi.stubEnv("REDDIT_CLIENT_ID", "");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "");
  });
  afterEach(() => {
    setXaiFetch(null);
    setRedditFetch(null);
    setMarketClient(null);
    vi.unstubAllEnvs();
  });

  it("searches X through Grok, only the saved accounts when asked, in batches of twenty", async () => {
    const { sara } = await team();
    await doAction(sara, "source.add", { source: "@DeItaone" });
    const { calls, fetcher } = recorder(() => grokReply("@DeItaone, 2026-10-09: \"Fed minutes hawkish\".", ["https://x.com/DeItaone/status/1"]));
    setXaiFetch(fetcher);

    const found = await tools(sara.personId).x_search({ query: "Fed minutes reaction", saved_only: true, handles: ["@zerohedge"], from_date: "2026-10-01" });
    expect(found).toContain("Fed minutes hawkish");
    expect(found).toContain("https://x.com/DeItaone/status/1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.ai/v1/responses");
    expect(calls[0].headers.Authorization).toBe("Bearer xai-test");
    expect(calls[0].body!.tools).toEqual([{ type: "x_search", allowed_x_handles: ["zerohedge", "DeItaone"], from_date: "2026-10-01" }]);
    expect(JSON.stringify(calls[0].body!.input)).toContain("Fed minutes reaction");

    const many = Array.from({ length: 25 }, (_, i) => `account${i}`);
    await tools(sara.personId).x_search({ query: "AI capex", handles: many });
    const batches = calls.slice(1).map((c) => (c.body!.tools as { allowed_x_handles: string[] }[])[0].allowed_x_handles.length);
    expect(batches).toEqual([20, 5]);
  });

  it("says what to do when X search isn't set up, or nothing is saved", async () => {
    const { sara } = await team();
    vi.stubEnv("XAI_API_KEY", "");
    expect(await tools(sara.personId).x_search({ query: "anything" })).toContain("XAI_API_KEY");
    vi.stubEnv("XAI_API_KEY", "xai-test");
    expect(await tools(sara.personId).x_search({ query: "anything", saved_only: true })).toContain("No X accounts are saved");
  });

  it("searches Reddit through Grok's web search when Mach1 has no Reddit app", async () => {
    const { sara } = await team();
    await doAction(sara, "source.add", { source: "r/SecurityAnalysis" });
    const { calls, fetcher } = recorder(() => grokReply("r/SecurityAnalysis, 2026-10-02: Micron thread, top comment says HBM is sold out."));
    setXaiFetch(fetcher);

    const found = await tools(sara.personId).reddit_search({ query: "Micron HBM", saved_only: true, time: "week" });
    expect(found).toContain("found through web search");
    expect(found).toContain("HBM is sold out");
    expect(calls[0].body!.tools).toEqual([{ type: "web_search", allowed_domains: ["reddit.com"] }]);
    expect(JSON.stringify(calls[0].body!.input)).toContain("only threads in r/SecurityAnalysis");
  });

  it("uses Mach1's Reddit app when there is one, with scores and top comments", async () => {
    const { sara } = await team();
    vi.stubEnv("REDDIT_CLIENT_ID", "id");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "secret");
    const post = { id: "abc", subreddit: "investing", title: "Micron after earnings", author: "val", score: 812, num_comments: 140, created_utc: 1_791_000_000, permalink: "/r/investing/comments/abc/micron/", selftext: "Margins at a record." };
    const { calls, fetcher } = recorder((url) => {
      if (url.includes("access_token")) return { access_token: "tok", expires_in: 3600 };
      if (url.includes("/comments/abc")) return [{}, { data: { children: [{ kind: "t1", data: { author: "skeptic", body: "Cycle peak, careful.", score: 95 } }] } }];
      return { data: { children: [{ kind: "t3", data: post }] } };
    });
    setRedditFetch(fetcher);

    const found = await tools(sara.personId).reddit_search({ query: "Micron", subreddits: ["r/investing"] });
    expect(found).toContain("r/investing · 812 points · 140 comments");
    expect(found).toContain("> 95 points, u/skeptic: Cycle peak, careful.");
    expect(found).toContain("https://www.reddit.com/r/investing/comments/abc/micron/");
    const search = calls.find((c) => c.url.includes("/search"))!;
    expect(search.url).toContain("https://oauth.reddit.com/r/investing/search?");
    expect(search.url).toContain("restrict_sr=1");
    expect(search.headers.Authorization).toBe("Bearer tok");
  });

  it("reads market data from Yahoo Finance, trimmed to what matters", async () => {
    const { sara } = await team();
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    setMarketClient({
      quote: async () => [
        { symbol: "MU", longName: "Micron Technology", currency: "USD", exchange: "NMS", regularMarketPrice: 140.5, regularMarketChangePercent: 2.1, marketCap: 157e9, trailingPE: 18.2 },
      ],
      quoteSummary: async () => ({}),
      chart: async () => ({
        meta: { currency: "USD" },
        quotes: [
          { date: day("2026-07-01"), close: 100, volume: 10 },
          { date: day("2026-08-01"), close: 120, volume: 10 },
          { date: day("2026-09-01"), close: 90, volume: 10 },
          { date: day("2026-10-01"), close: 135, volume: 10 },
        ],
      }),
      fundamentals: async () => [],
      search: async () => ({ quotes: [{ symbol: "RR.L", longname: "Rolls-Royce Holdings plc", quoteType: "EQUITY", exchDisp: "London" }] }),
    });
    const market = tools(sara.personId).market_data;

    const quote = await market({ action: "quote", symbols: ["mu"] });
    expect(quote).toContain("MU · Micron Technology");
    expect(quote).toContain("Price 140.50 (2.10% on the day)");
    expect(quote).toContain("Market cap: 157B");
    const history = await market({ action: "history", symbols: ["MU"], period: "6mo" });
    expect(history).toContain("2026-07-01 100.00 → 2026-10-01 135.00: 35.0%");
    expect(history).toContain("max drawdown -25.0%");
    expect(await market({ action: "search", query: "Rolls-Royce" })).toContain("RR.L: Rolls-Royce Holdings plc (EQUITY, London)");
    expect(await market({ action: "financials", symbols: ["MU"] })).toContain("No income statement for MU");
    expect(await market({ action: "profile" })).toBe("Give a symbol for profile.");
  });
});
