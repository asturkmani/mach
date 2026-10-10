# Research

The Researcher is a built-in agent for the research a family office does: companies and stocks, sectors,
funds and managers, people (due diligence), markets and macro. It reads the web and filings, market data, X
and Reddit, starts with the sources each person trusts most, and delivers a brief that leads with the
insight and sources every claim.

## Asking for it

Like everything in Mach1, it's asked for in chat (the panel, WhatsApp or email). The Chief of Staff:

| They ask | It does |
| --- | --- |
| A price, a number, what one account is saying | Answers itself (`market_data`, `x_search`, `web_search`) |
| A question that needs judgment across sources ("what's the market saying about Micron's guidance?") | `start_research` with depth quick: the Researcher answers in the chat within a few minutes, or it becomes a task if it needs longer |
| Real research ("a brief on…", due diligence on a manager, a sector primer) | `start_research` with depth brief: a task the Researcher works on and reports back from, on WhatsApp too |
| A regular digest ("every Monday, what my sources say about AI chips") | A brief with `repeat`: a recurring task, the Researcher doing each run |

The Researcher is made the first time it's needed (like the Developer) and then appears with the other
agents, so `create_task` and `ask_specialist` can name it too. Its model: its own (Team → Researcher), else
the company's default for agents, else `RESEARCH_AGENT_MODEL`, else `AGENT_MODEL`.

## How it works

Its playbook is the `research` skill (`lib/agents/skills.ts`), which any agent can load:

1. **Frame**: restate the question as a brief (the decision it informs, the scope, what a good answer holds)
   and split it into three to six questions.
2. **Gather**: high-signal sources first, then wider. The Researcher sends each question to a sub-researcher
   with `investigate`, several at once; each searches, reads the best sources and comes back with dated
   findings labelled Fact, Estimate or Opinion and numbered sources. It follows up on the gaps, two or three
   rounds at most. Numbers are calculated in its sandbox, not in its head.
3. **Think**: what's missing, where sources disagree, the strongest case against its own view, and whether
   sentiment on X and Reddit agrees with the numbers.
4. **Write**: a brief as a file on the task (an outline per kind: company, sector, fund or manager, person,
   macro event), and a phone-length report leading with the insight.

This borrows from open-source research agents rather than vendoring one (none fits a TypeScript app on
Vercel): the lead researcher with parallel sub-researchers and compressed, cited findings from LangChain's
[open_deep_research](https://github.com/langchain-ai/open_deep_research) (MIT), the bull and bear challenge
from [TradingAgents](https://github.com/TauricResearch/TradingAgents), computing numbers in code from
FinRobot, and report outlines like those in [anthropics/financial-services](https://github.com/anthropics/financial-services).

## The tools

Every agent and the Chief of Staff have them (`researchTools` in `lib/agents/toolkit.ts`); only the
Researcher has `investigate`.

| Tool | What | Where it comes from |
| --- | --- | --- |
| `web_search`, `fetch_page` | The web, filings, news; `source_policy.include_domains` limits a search to chosen sites | AI Gateway (Parallel, Browserbase) |
| `market_data` | Quotes (stocks, FX, indices, crypto), profile and key numbers, price history with drawdown and volatility, statements, news, holders and insider trades, analysts | Yahoo Finance through [yahoo-finance2](https://github.com/gadicc/yahoo-finance2): free, delayed, unofficial |
| `x_search` | What's said on X, by anyone or only by chosen or saved accounts, in a date range | xAI's `x_search` tool (Grok searches X and reports the posts with links) |
| `reddit_search` | Reddit threads, in chosen or saved subreddits or by chosen users | Mach1's Reddit app if it has one (scores and top comments), else Grok's web search of reddit.com |
| `investigate` | One question to a sub-researcher with all the above | The Researcher's own model (`lib/research/tools.ts`) |

**No one signs in.** X goes through xAI's API with the company's own xAI key if an admin added one
(Settings → AI), else Mach1's `XAI_API_KEY`. That keeps people's X accounts out of it, and X's terms with it;
a login or cookies would break both. Reddit closed its open JSON to servers in 2026 and approves API apps one
at a time, so a Reddit app (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`) is optional: without one, searches go
through Grok's web search. Yahoo Finance needs nothing.

**Costs**: web search is a few dollars per thousand searches on AI Gateway; xAI charges per post X search
reads (about $5 per thousand) plus Grok's tokens; Yahoo Finance is free. A brief with `investigate` runs
several sub-researchers, so it costs more model calls than a quick answer.

## High-signal sources

The websites, X accounts, subreddits and Reddit users someone trusts most (`research_sources`). Saved in
chat ("save @DeItaone as high signal for macro news": `source.add`) or under **Research** in the left menu,
each with a note on why it's worth reading. They're the saver's own unless they share them for the company's
research; whoever saved one, or an admin for the company's, can change or remove it (`lib/operations.ts`).

How they're used: an agent researching for someone (on a task they asked for, or answering them through the
Chief of Staff) gets theirs and the company's in its instructions, grouped by kind with the notes, and is told
to look there first and weigh them higher: `web_search` limited to the saved sites, then `x_search` and
`reddit_search` with `saved_only`, which fill in the saved accounts, subreddits and users themselves (X takes
20 accounts a search, so more go in batches). Briefs mark findings from them with ★. Mach1's agents for code
and integrations don't get them.

## Set up

- `XAI_API_KEY` for X (and Reddit without an app). Optional: `X_SEARCH_MODEL` (default `grok-4-fast`).
- Optional: `RESEARCH_AGENT_MODEL`, a strong reasoning model.
- Optional: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `REDDIT_USER_AGENT` for an approved Reddit app.

## Code

| File | |
| --- | --- |
| `lib/research/sources.ts`, `store.ts` | Saved sources: reading what people type or paste, labels, the prompt listing, storage |
| `lib/research/market.ts` | Yahoo Finance, trimmed to the numbers that matter |
| `lib/research/x.ts`, `reddit.ts` | X search through xAI, Reddit through its API or Grok's web search |
| `lib/research/steps.ts`, `tools.ts` | The tools (durable steps on tasks), and `investigate` |
| `lib/actions/research.ts`, `app/(app)/research/` | `source.add`, `source.update`, `source.remove`, `source.list`, and the Research screen |
| `lib/agents/store.ts` (`researchAgent`), `lib/agents/chief-of-staff.ts` (`start_research`) | The Researcher, and handing research to it |
