# Mach

A command center for running a small or medium-sized business, where people and AI agents work together in one place: a shared company profile and brain, a Chief of Staff agent coordinating worker agents, a Kanban board with automatic dispatch to agents, and agents reachable over WhatsApp and email.

Built in TypeScript on Vercel (Next.js, AI SDK, AI Gateway), with Neon Postgres for data and WorkOS AuthKit for sign-in, companies and invitations.

- [Product specification (draft)](docs/spec.md)

## What works today

1. **Sign in** with WorkOS (Google, Microsoft, email magic link — whatever you enable in WorkOS).
2. **Create your company**: name and website (guessed from your work email). This creates a WorkOS organization with you as admin. Signing up with a work email claims its domain (e.g. `cedarlegacy.com`): colleagues who sign in later with the same domain are told the company is already on Mach and asked to get an invite, instead of creating a duplicate. Personal addresses (gmail.com, outlook.com, …) claim nothing, so anyone using one can create a company of their own.
3. **Chief of Staff onboarding**: a short chat that captures just the essentials — what the company does (it reads your website first), the team and reporting lines, and the top priorities — then marks onboarding complete. It looks things up on the web instead of asking you to explain tools or companies.
4. **Team page**: the people in the org chart and the company's agents, together (filter to All, People or Agents). People show their status:
   - **Not invited** — in the org chart, no login.
   - **Invited** — WorkOS emailed them an invitation; you can also copy the link and send it on WhatsApp.
   - **Joined** — they signed in. People are matched to their entry by email.

   Add people, change who they report to, invite or remove them (admins only). Create agents from the same page.
5. **Home**: what needs you at the top (an agent finished or asked something), urgent first, two lines per task: what happened and what's needed. Agents end with up to three options (one recommended) that you pick with a key. Below it, all the company's work (or just yours) as a board you can drag cards across, or as a to-do list grouped into in progress, waiting on someone else, later, backlog and done. <kbd>V</kbd> switches between them. When something new needs you, Mach shows a toast and, if you turn them on (the menu under your name, or Settings → Account), a browser notification.
6. **Tasks**: any mix of people and agents can be on a task. Agents on it see all of it: the ask, the summary, the whole thread, the files and everyone on it. When an agent finishes or needs a decision, the task comes back to the people's inboxes; replying (or picking an option) sends it back to the agent. Agents can save files on a task (a model as CSV, a report as markdown), previewed on the page and downloadable.
   - **@-mentions**: type `@` in a reply to tag a person or an agent. Either one joins the task. A mentioned person sees it in their **Needs you**. A mentioned agent is the one that picks up the reply, and a message that mentions only people doesn't wake any agent.
   - **Attachments**: attach files to a reply with the paperclip, by pasting a screenshot, or by dropping them on the reply box. Images show in the thread and other files are downloads. They join the task as inputs in the file library, and attaching a file with a deliverable's name saves its next version. Agents get the files in their sandbox and see the images themselves.
   - **Live status**: an agent reacts 👀 to the reply it picks up, then ✅ done, 💬 asked, 🤝 handed off or ⚠️ hit a problem. While it works, the task, its Home card and the left menu show what it's doing ("Running summarise.py") and for how long.
7. **Agents**:
   - **Defined agents** have a standing profile (role, job description, instructions) and get the same kind of work again and again, e.g. sales outbound or financial analysis. Create them from a template on the Team page or by asking the Chief of Staff.
   - **Worker agents** are made for one task (with a role like "Financial analysis") and archived when the task closes.
8. **Chief of Staff panel** on the right of every page (<kbd>C</kbd>, or the Chief of Staff button in the page header). Ask it questions or tell it what needs doing; it creates tasks with the right people and agents. Attach files or photos with the paperclip, by pasting or by dropping them: it sees images and small text files itself, and every attachment is saved to the company files so a task can start from it. **What I know** in its header opens the company profile it keeps. As it learns things about the company in conversation it suggests profile updates, which you apply or dismiss from a card or your inbox. It loads short playbooks ("skills") for writing the profile, writing tasks, designing agents, research, financial analysis and connecting integrations. It's built from the same toolkit as every agent (research, data sources, a sandbox and its browser), working in the company's own workspace sandbox, so it can read pages behind a sign-in and set up integrations itself.
9. **Sandboxes and files**: an agent that needs to compute something gets a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) for the job, with Python's data stack, LibreOffice and headless Chromium (Playwright) preinstalled. It writes and runs code there and attaches real files: Excel models with working formulas, charts, CSVs. Deliverables are previewed on the task page (spreadsheets sheet by sheet) with every version kept; the code sits in a collapsed section with each script's last run output. The sandbox lasts until the job is archived, so replies pick up where the agent left off. Every deliverable and script lands in the company file library (**Files**), and any job can start from a file another job made.
10. **Recurring jobs**: "every weekday at 4pm, chart the option flow" gives the job a schedule. Each run lands on the same card, in the same sandbox. When the job has a `run.sh`, scheduled runs replay it without a model and the changed deliverables become their next versions; the agent is woken only if it fails. Set, pause or change a schedule from the job's **Repeats** panel, which also has **Run script again**.
11. **Company drive**: shared data every job's sandbox sees at `/vercel/drive` (a price history a daily job appends to, an export someone uploaded). It lives in Vercel Blob and is listed, downloadable and uploadable on the Files page.
12. **Integrations**: connect the company's other systems by giving the Chief of Staff the docs. A **data source** is an API that agents call with `call_api` or straight from sandbox code, read-only unless you allow writes. A **website login** is an account that chosen agents sign in to with a headless browser in their sandbox, for data entry where there's no API. When a site asks for a sign-in code, the job asks the people on it and they reply with the code. Credentials go in a form straight to sealed storage, never through a model or a chat, and requests from sandboxes are signed at the network layer. Each integration is company-wide and can be limited to chosen agents; manage them in Settings → Integrations. See [docs/integrations.md](docs/integrations.md).
13. **WhatsApp and email**: message the Chief of Staff on WhatsApp from your own number (through Twilio), or email your company's Chief of Staff address (an AgentMail inbox, e.g. `cedar-legacy@agentmail.to`). It's the same conversation as the chat panel. Only team members who use Mach get answers. Set them up in Settings → Channels; each person links their WhatsApp number in Settings → Account. See [docs/channels.md](docs/channels.md).
14. **Pages**: ask the Chief of Staff for a view of your data ("net worth by entity from Masttro, every weekday at 7am") and it builds a page, pinned as a tab on Home. Pages read the company's tasks, people and agents live, and integrations through a script that saves the data to the drive. It writes the page as HTML that reads them, checks it in its sandbox browser, and sets up a quiet job that refreshes the data on schedule without a model (only a failure reaches anyone). Pages run in a sandboxed frame that can't connect anywhere; every version is kept. See [docs/pages.md](docs/pages.md).
15. **Works on a phone**: below tablet width the left menu becomes a bar at the bottom (Home, Chief of Staff, New task, Search, Menu), the Chief of Staff opens as a full-screen sheet, the board's columns swipe, and a task's details follow its thread. Admins can also delete the company, with everything it has in Mach, from Settings → General.
16. **Keyboard first**: <kbd>J</kbd>/<kbd>K</kbd> move, <kbd>V</kbd> board or list, <kbd>Enter</kbd> opens, <kbd>E</kbd> approves the recommendation or marks done, <kbd>1</kbd>–<kbd>3</kbd> pick an option, <kbd>R</kbd> reply, <kbd>L</kbd> later, <kbd>Z</kbd> undo, <kbd>N</kbd> new task, <kbd>S</kbd> summary, <kbd>/</kbd> search, <kbd>⌘K</kbd> everything else, <kbd>?</kbd> all shortcuts. Light and dark themes.

Agent runs are durable [Vercel Workflow](https://workflow-sdk.dev) runs (`workflows/agent-run.ts`). Every model call and every database change is its own step, retried on failure, so a run can take as long as the work needs instead of one function's time limit. Runs hold a lease on the task so only one runs at a time, pick up replies that arrive mid-run, and stop after six agent turns in a row without a person, so agents can't hand work back and forth forever. Locally, runs use Workflow's local world (data in `.workflow-data/`); inspect them with `npx workflow web` or `npx workflow inspect runs`.

How sandboxes, files, recurring jobs and the drive work, and why: [docs/sandbox.md](docs/sandbox.md). Data sources, website logins and how credentials are kept out of models: [docs/integrations.md](docs/integrations.md).

The company profile is one markdown document per company, stored in Postgres. Its people section is generated from the `people` table.

Each person's conversation with the Chief of Staff is stored in Postgres too, so it survives a reload. The browser only sends the newest message; the server loads the history, repairs known AI Gateway result-shape mismatches, validates it and saves the reply.

## Set up

### 1. WorkOS

1. Create a free account at [workos.com](https://workos.com) and open the **Staging** environment.
2. **Authentication**: enable the sign-in methods you want (e.g. Google OAuth, Magic Auth).
3. **Redirects**:
   - Redirect URI: `http://localhost:3000/callback` (add your Vercel URL + `/callback` later)
   - Initiate login URI: `http://localhost:3000/sign-in`
   - Sign-out redirect: `http://localhost:3000`
4. **Roles**: make sure an `admin` role exists (company creators get it).
5. Copy the API key and client ID.

### 2. Database

Add **Neon** from the Vercel Marketplace (Storage → Create → Neon) and connect it to the project, or create a free project at [neon.com](https://neon.com). Then:

```bash
vercel env pull .env.local   # or paste DATABASE_URL into .env.local yourself
pnpm db:migrate              # creates the tables (safe to re-run)
```

### 3. Run it

```bash
pnpm install
cp .env.example .env.local   # fill in WorkOS, DATABASE_URL, AI_GATEWAY_API_KEY, CHIEF_OF_STAFF_MODEL
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000, sign in, create your company, then click **Start onboarding**.

For agents that run code, the project needs Vercel Sandbox access (`vercel link` and `vercel env pull` give you a development token) and, so new sandboxes start with the data stack already installed, a template snapshot:

```bash
pnpm sandbox:template   # builds and snapshots sandbox/template.json (about a minute); rerun after changing it
```

Files are stored in a private Vercel Blob store when one is connected (`BLOB_READ_WRITE_TOKEN`), otherwise in Postgres. Create one with `vercel blob create-store mach-files --access private`, which connects it to the project. Uploads to the company drive and attachments in task threads need it.

Integrations need `MACH_SECRETS_KEY` (`openssl rand -base64 32`), which seals their credentials. Use the same key everywhere that shares the database, or `vercel env pull` it.

The Chief of Staff's web search and page-reading tools run through AI Gateway (Parallel search and Browserbase fetch, a few dollars per thousand calls) and are billed to your AI Gateway credits, even when the model itself uses your own provider key.

### Deploy to Vercel

1. Import the repo; connect Neon from the Marketplace.
2. Add the WorkOS variables and `CHIEF_OF_STAFF_MODEL` (and optionally `AGENT_MODEL` for task agents). Set `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to `https://<your-domain>/callback` and add the same URL in WorkOS.
3. Connect a private Blob store, and add `CRON_SECRET` (any long random string) so the every-minute cron in `vercel.json` can start recurring jobs. Cron runs only on production deployments. Add `MACH_SECRETS_KEY` for integrations.
4. Deploy. Vercel builds run `vercel-build`, which applies `db/schema.sql` before building, so the production tables are created automatically.

## Checks

```bash
pnpm test        # unit tests against an in-memory Postgres (PGlite) with WorkOS mocked
pnpm typecheck
pnpm lint
pnpm build
```

## Layout

| Path | What it is |
|---|---|
| `proxy.ts` | Requires sign-in on every route except `/callback`, `/sign-in`, the workflow runtime and the cron tick |
| `app/welcome/` | Create-your-company step |
| `components/shell/` | App shell: left rail, Chief of Staff panel, shortcuts, ⌘K palette, dialogs, undo |
| `app/(app)/page.tsx`, `components/home.tsx` | Home: what needs you, then the work as a board or a list |
| `app/(app)/tasks/` | Task page and its server actions |
| `app/(app)/pages/`, `components/page-view.tsx`, `page-tabs.tsx` | Pages: the list, a page with its header and sandboxed frame, the frame's document route, and Home's tabs |
| `lib/pages.ts`, `lib/page-frame.ts`, `lib/agents/page-tools.ts`, `page-steps.ts` | Page storage and versions, refresh jobs, the frame's document and policy, and the Chief of Staff's page tools and browser check |
| `app/(app)/files/`, `drive/`, `app/api/drive/`, `app/api/uploads/` | The file library and company drive: pages, downloads, previews and uploads (drive files, and attachments in task threads) |
| `app/(app)/integrations/`, `lib/integrations.ts`, `lib/secrets.ts` | Integrations: the page, storage and sealing, signing, and the sandbox network policy |
| `lib/agents/integration-steps.ts`, `browser-steps.ts` | Agent tools for data sources (`call_api`, guides) and website logins (`browser_login`, sign-in codes) |
| `lib/mentions.ts`, `lib/task-mentions.ts`, `components/mention-textarea.tsx` | @-mentions: finding them, recording them, and the reply box that suggests names |
| `components/reply-attachments.tsx` | Attachments in the reply box and the thread |
| `app/api/cron/tick/route.ts`, `vercel.json` | The every-minute cron that starts recurring jobs |
| `app/(app)/team/`, `agents/[id]/`, `company/` | The Team page (people and agents), an agent's page, the company profile |
| `app/(app)/settings/` | Settings: General, Integrations, Channels and Account |
| `components/shell/rail.tsx` | The left menu: Home, Team, Files, the company menu and the menu under your name |
| `app/api/chat/route.ts` | Streams the Chief of Staff's replies for the signed-in company |
| `lib/agents/chief-of-staff.ts` | The Chief of Staff: instructions and its company tools on top of the shared toolkit, in its workspace sandbox |
| `workflows/agent-run.ts`, `scheduled-run.ts` | The durable workflows an agent run, and a recurring job's run, execute in |
| `app/api/whatsapp/`, `app/api/email/`, `lib/channels/` | WhatsApp (Twilio) and email (AgentMail): webhooks, matching senders, replies |
| `lib/agents/cos-turn.ts` | One Chief of Staff turn, shared by the chat panel, WhatsApp and email |
| `lib/agents/toolkit.ts` | The tools every agent shares (research, skills, data sources, sandbox, browser); each runtime adds its role's tools |
| `lib/agents/runner.ts`, `run-steps.ts`, `prompts.ts`, `dispatch.ts` | Agent runs on tasks: orchestration (WorkflowAgent), task tools, their durable steps, what the agent reads, and starting runs |
| `lib/agents/sandbox-steps.ts`, `lib/sandbox.ts`, `sandbox/` | Sandbox tools, the job sandbox provider and the template's setup |
| `lib/agents/scheduled.ts`, `schedule-steps.ts`, `lib/schedules.ts` | Recurring jobs: replaying run.sh or waking the agent, and schedule storage |
| `lib/files.ts`, `lib/drive.ts`, `lib/storage.ts`, `lib/previews.ts` | The file library, the company drive, Blob or Postgres storage, and previews |
| `lib/agents/skills.ts`, `templates.ts`, `store.ts` | Skills (playbooks), agent templates and agent storage |
| `lib/tasks.ts`, `lib/work.ts` | Task storage, and what people and agents do to tasks |
| `lib/agents/history.ts`, `lib/chats.ts` | Stored chat history: loading, repairing, validating and saving |
| `lib/session.ts` | Signed-in user, current company and their person record |
| `lib/people.ts`, `lib/orgs.ts`, `lib/profile/` | Data access for people, companies and the profile |
| `db/schema.sql` | Database schema |
