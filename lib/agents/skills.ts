import { tool } from "ai";
import { machSourceList } from "@/lib/mach-sources";
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
- Agents: use a defined agent when its role fits the work. Otherwise add a worker agent with a clear role (for example "Financial analysis"), which is made for this task only. Every agent can run code in its own sandbox, so models, simulations and data work are fine to delegate.
- Files: when the work builds on an existing company file, start the job from it (create_task's files), and say in the description what should change.
- Repeats: when the work should happen on a schedule, pass repeat (cron in the company's timezone) and say in the description what each run delivers and what to keep on the company drive. One recurring task, not one task per run.
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
- Build the model in your sandbox as an xlsx (load the excel-models skill): assumptions as input cells, the model as formulas that reference them, and the script that builds it kept under code/ so it can be rebuilt. Attach it with attach_file.
- In your report, give the headline numbers, the key assumptions and the main risks in a few sentences. The full table belongs in the file.`,
  },
  {
    name: "excel-models",
    description: "Building Excel models and simulations in the sandbox that people can open, check and change.",
    body: `Build workbooks with a Python script (openpyxl) kept under code/, so the model can be rebuilt after any change. Put the inputs in a config file (config.yaml or config.json) the script reads.

Layout:
- An Assumptions sheet: one input per row with a label, the value and a unit or note. Style inputs as inputs (blue font), so people know what they may change.
- Calculation sheets that use real formulas referencing the assumption cells (=Assumptions!B3*(1+Assumptions!B4)), never pasted numbers, so changing an input updates the model.
- For simulations (Monte Carlo and similar), run the simulation in Python with a fixed random seed, write the per-run results or a percentile table to a sheet, and say in the Assumptions sheet that the simulated values are static outputs of the script.
- A Summary sheet first, with the handful of numbers people asked for, referencing the other sheets.
- Number formats on every number (0.0%, #,##0, $#,##0.00), sensible column widths, frozen header rows, units in labels ("Revenue ($M)").

Charts: save PNGs with matplotlib (dpi 150, labelled axes, a title, units) in outputs/ and attach them; optionally also add the image to the Summary sheet.

Checks before you attach:
- Run recalc on the file (the attach step also does this) and read it back with openpyxl(data_only=True) to make sure no cell shows an error (#REF!, #DIV/0!, #NAME?) and the key numbers match what your script computed.
- Report the headline numbers from the recalculated file, not from memory.`,
  },
  {
    name: "connecting-integrations",
    description: "Connecting one of the company's systems as a data source from its API docs, so every agent can use it.",
    body: `A data source lets agents call a company system's API without ever seeing its credentials. Set it up yourself, in the chat: never create an agent or a task to do it.

1. Read the API docs: fetch_page on the URL they gave, or a file they attached. If that comes back empty or as a sign-in page, the docs need a browser:
   - browse the URL: it opens it in the browser in your sandbox.
   - If it needs a sign-in: reuse the company's login for that site if there is one, else connect_login for it (the docs site, e.g. https://app.example.com/api/index.html as the sign-in page; leave agents out when only you need it). Ask them to enter their username and password in the card. When they say it's done, call browser_login, then browse again. If the site sends a sign-in code, they get a card to enter it; when they say it's entered, call browser_login again.
   - API docs pages (Swagger UI, Redoc) load their spec as JSON or YAML: browse lists it under "Data the page loaded". Browse that URL with save_as (e.g. inputs/openapi.json), then run_code to list its servers, security schemes and GET endpoints rather than reading it all.
   Find: the base URL, how requests are authenticated (header, query parameter, or a token exchanged first), a cheap GET that proves the credentials work (a "me", "accounts" or "ping" endpoint), and whether it's read-only.
2. Call connect_data_source with:
   - fields: what the person must enter, e.g. [{ name: "apiKey", label: "API key" }] or an API key and secret, or a client id and secret. Mark non-secret ones (a tenant id) secret: false.
   - headers (or query) as templates: "Authorization": "Bearer {{apiKey}}", "X-Api-Key": "{{apiKey}}", "Authorization": "Basic {{basic:username:password}}".
   - token, when the API swaps credentials for a short-lived token first (OAuth client credentials or a login endpoint): its url, format (form or json), body templates, path to the token in the response and expiresInPath; then sign requests with "Bearer {{token}}".
   - testPath: the cheap GET.
   - access: read unless they asked for agents to change data there.
   - agents: leave out to give every agent access; name agents to limit it.
   - guide: a short markdown guide for agents: what data it holds, the main endpoints with their parameters, paging, rate limits, field meanings and gotchas.
3. Never ask for credentials in the chat. The tool shows them a secure card to enter them, which tests the connection. If they paste a key in the chat anyway, tell them to enter it in the card instead (Mach1 scrubs it from the chat when they do) and to consider rotating it.
4. When they say the credentials are in, check it with call_api on the test path and tell them what you can see. Then you can answer quick questions from it, and jobs can use it. For regular pulls (positions every morning), create a recurring task that saves them to the company drive.

Website logins for work: when the work needs a website with no API, or changes the API can't make (an API that's read-only, data entry), use connect_login for the agents who'll do it: the sign-in page, a page that only shows when signed in, and the agents allowed to use it (the defined agent for that recurring work, e.g. "Masttro data entry"; create one only for such work, never just to read docs or set up a connection). The card asks for the username and password, and optionally an authenticator setup key so agents can answer sign-in codes themselves; without it, codes come to the people on the job as a question. A company can have both for one system: a read-only data source every agent reads, and a login one agent uses for changes.`,
  },
  {
    name: "building-pages",
    description: "Building a page: a report on company data (a dashboard) in Pages that stays up to date.",
    body: `A page is a view of the company's data that people keep coming back to (net worth by entity, cash across banks, the pipeline), in Pages. Build one when someone asks for a dashboard, a view or a page, or to "see X every morning". Answer one-off questions in the chat instead.

Only build a page on real data. If the data isn't available (the system isn't connected, there are no files for it), don't build a placeholder page, write "pending" data or schedule a refresh: tell them what's needed (connect the bank or Masttro, or upload a file) and offer to do that first.

How a page works:
- Its data is files on the company drive (/vercel/drive), and Mach1's own data. The page is one HTML document that reads them from window.mach.data, keyed by what you listed in save_page's data: a drive path ("pages/net-worth/data.json") arrives parsed, CSV and text as text (mach.csv(path) turns CSV into objects).
- Mach1's own data is read live each time the page opens, with no script or refresh job: list it by name in data.
${machSourceList()}
  For a page of the company's work (open tasks by person, what's overdue, what agents are doing), use mach:tasks and mach:people, not a script. Link a task with its url (an <a href> to /tasks/12): it opens in Mach1.
- It can't fetch anything (no fetch, no API calls, no images from the web): it runs sandboxed with no network. Everything it shows comes from its files.
- Keep data and page apart: a script makes the data, the page only draws it. Shape the data for the page (a small JSON with exactly what it shows: totals, rows, series, and an as_of time), not a raw API dump.

Steps:
1. Get the data (skip this for a page that only reads Mach1's own data). If it lives in a system that isn't one of the company's data sources yet (say Masttro, with only a docs login connected), connect it first with the connecting-integrations skill, then come back to the page. From a data source: explore it with call_api (small requests), then write a script on the drive, /vercel/drive/pages/<slug>/refresh.py, that calls the API and writes /vercel/drive/pages/<slug>/data.json. Call the API at its normal URL with plain requests; Mach1 signs requests from the sandbox, so never put credentials in code. Run it (run_command: python3 /vercel/drive/pages/<slug>/refresh.py) and read the file back to check its shape. From data already on the drive, read it and, if it's big, write a smaller summary file for the page.
2. Write the page with save_page, a whole HTML document:
   - Mach1's look comes with it. Use its CSS variables (--ink, --muted, --faint, --line, --raised, --panel, --accent, --up, --down, --series-1 to --series-8) and classes: .label (small uppercase label), .stats holding .stat blocks (each with .label, .value and .note) for headline numbers, .table-wrap around a table (th.num and td.num right-align numbers), .card, .grid, .row, .stack, .muted, .up, .down, .empty. Don't restyle the body or load other fonts; light and dark mode then work by themselves.
   - Helpers: mach.money(value, "USD"), mach.number(value), mach.percent(0.123) gives "12.3%", mach.ago(date), mach.file(path).updatedAt, mach.csv(path).
   - Plain JavaScript in a script at the end of the body that builds the page from mach.data. When a file is missing (mach.data[path] is undefined), show an .empty block saying the data isn't there yet.
   - Lead with what matters: three to five headline numbers, then the main table or chart, then detail. Say when the data is from ("Data as of 07:02").
   - Mach1 shows the page's title above it: don't repeat it as a heading. Keep it calm: no coloured side borders, banners or gradients; notes go in .muted text.
   - Charts: bars made of divs, or inline SVG, are usually enough. For more, load one library with an exact version from https://cdn.jsdelivr.net/npm/ (Observable Plot or Chart.js). Use the --series colours in order, label the values, one axis per chart.
   - It must work on a phone: tables in .table-wrap, rows that wrap.
   - Keep data out of the HTML (it has a 1 MB limit).
3. save_page checks the page in your sandbox browser: fix any script errors, a blank page or overflow, and save again.
4. To keep it fresh, call refresh_page with the command from step 1 and a schedule in their timezone ("every weekday at 7am" is 0 7 * * 1-5). If they didn't say how often, data that changes daily refreshes each weekday morning. Runs are quiet; only failures reach people.
5. Tell them in a line or two what it shows and that it's in Pages.

Changing a page later: read_page, then save_page with page set to its slug, the whole new HTML and a short note on what changed. Every version is kept, and people can go back to an earlier one.`,
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
