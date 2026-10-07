import { tool } from "ai";
import { z } from "zod";

// Skills are short playbooks an agent loads when a job calls for one. The
// system prompt lists each skill's name and description; the full text is only
// read (with use_skill) when it's needed, which keeps every prompt small.

export type Skill = { name: string; description: string; body: string };

export const SKILLS: Skill[] = [
  {
    name: "company-profile",
    description: "Keeping the company profile accurate and useful: what each section holds and how to write it.",
    body: `The company profile is what every agent reads before it works, so it should be short, current and true.

What each section holds:
- Overview: what the company does and for whom, in two to four sentences.
- Mission, Vision & Values: only what the company itself has said. Never invent values.
- Goals: the current top priorities, as a short list, each with a timeframe if known.
- People & Responsibilities: generated from the people list. Never edit it directly.
- Agents: the agent team and what each one does.
- Products & Services: what they sell, to whom, and how it's priced if known.
- Customers & Market: who buys, segments, geography, main competitors.
- How We Work: tools they use, policies, tone of voice, approval norms, working hours.
- Glossary: company-specific terms, products, tools and acronyms, one line each.

How to write it:
- Use the company's own words. Be concise and factual. One idea per line.
- Keep everything that is still true when you rewrite a section; a change replaces the whole section.
- Look things up instead of asking (a tool, a client, a market term) and record what you learn.
- Date anything that will go stale ("as of Oct 2026").

When to suggest a change:
- Whenever a conversation reveals a fact the profile doesn't have, contradicts it, or makes it stale.
- One suggestion per section, with the full new section text and a one-line reason.
- Don't suggest changes for opinions, guesses or one-off details that won't matter next month.`,
  },
  {
    name: "writing-tasks",
    description: "Turning a request into a task that people and agents can act on, and choosing who should be on it.",
    body: `A good task can be picked up by someone who wasn't in the conversation.

- Title: the outcome, starting with a verb, under 60 characters. "Review Micron's Q4 earnings", not "Micron".
- Description: the goal, the inputs or sources to use, what done looks like (the deliverable and its format), and any deadline. Short paragraphs or a short list.
- People: always include the person who asked. Add anyone else who must decide or act.
- Agents: use a defined agent when its role fits the work. Otherwise add a worker agent with a clear role (for example "Financial analysis"), which is made for this task only.
- Priority: leave it at medium unless they said it is urgent or important.
- One task per outcome. Check the open tasks first and don't create a duplicate.`,
  },
  {
    name: "designing-agents",
    description: "Defining an agent with a clear, repeatable job: name, role, description and instructions.",
    body: `Create a defined agent when the same kind of work will come up again (sales outbound, bookkeeping, financial analysis). For a one-off job, use a worker agent on the task instead.

- Name: short and plain, usually the job ("Bookkeeper", "Sales outbound").
- Role: a few words, like a job title.
- Description: what it is responsible for and what good work looks like, in two to four sentences.
- Instructions: specific do's and don'ts, sources to use, tone, formats for deliverables, and when to ask a person instead of deciding.`,
  },
  {
    name: "research",
    description: "Researching a company, market or topic on the web and reporting what is known, with sources.",
    body: `- Start with web_search to find primary sources: the company's investor relations site, filings, official announcements. Then read the best ones with fetch_page.
- Prefer primary sources over news, and news over blogs. Note the date of every figure.
- Separate facts (reported, with a source) from estimates and opinions (yours or analysts'), and label each.
- Cite sources as links next to the facts they support.
- If two sources disagree, say so and give both.
- Stop when you can answer the question. Don't read twenty pages when three will do.`,
  },
  {
    name: "financial-analysis",
    description: "Reviewing a company's earnings and building a simple projection model with stated assumptions.",
    body: `Earnings review:
- Find the latest reported quarter: the earnings release, the 10-Q or 10-K, and the guidance for the next quarter. Note the fiscal calendar; many companies' fiscal quarters don't match calendar quarters.
- Report revenue, gross margin, operating income, net income and EPS (GAAP and non-GAAP if both are given), each with the year-on-year and quarter-on-quarter change.
- Add segment or product revenue, key KPIs, cash flow, capex and net cash or debt.
- Compare results and guidance with consensus when you can find it, and say what drove the quarter.

Projection model:
- Build quarterly columns: the last two to four reported quarters, then the projected quarters, clearly marked as estimates (for example "FQ1 2027E").
- Rows: revenue (by segment if it matters), gross margin %, gross profit, operating expenses, operating income, operating margin %, tax rate, net income, diluted shares, EPS.
- Drive the projections from a few explicit assumptions listed at the top or bottom: revenue growth per quarter, margins, opex growth, tax rate, share count. Anchor the first projected quarter to company guidance.
- Save the model with save_output as a CSV (one header row of quarters, one row per line item, numbers without currency symbols, units stated in the row label, e.g. "Revenue ($M)").
- In your report, give the headline numbers, the key assumptions and the main risks in a few sentences. The full table belongs in the file.`,
  },
];

export function skillList(skills: Skill[] = SKILLS): string {
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

export function skillTool(skills: Skill[] = SKILLS) {
  const names = skills.map((s) => s.name) as [string, ...string[]];
  return tool({
    description: "Load a skill: a short playbook for a kind of work. Use it before doing that kind of work.",
    inputSchema: z.object({ name: z.enum(names) }),
    execute: async ({ name }) => skills.find((s) => s.name === name)!.body,
  });
}
