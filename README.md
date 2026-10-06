# Mach

A command center for running a small or medium-sized business, where people and AI agents work together in one place: a shared company profile and brain, a Chief of Staff agent coordinating worker agents, a Kanban board with automatic dispatch to agents, and agents reachable over WhatsApp and email.

Built in TypeScript on Vercel (Next.js, AI SDK, AI Gateway), with Neon Postgres for data and WorkOS AuthKit for sign-in, companies and invitations.

- [Product specification (draft)](docs/spec.md)

## What works today

1. **Sign in** with WorkOS (Google, Microsoft, email magic link — whatever you enable in WorkOS).
2. **Create your company**: name and website (guessed from your work email). This creates a WorkOS organization with you as admin.
3. **Chief of Staff onboarding**: a short chat that captures just the essentials — what the company does (it reads your website first), the team and reporting lines, and the top priorities — then marks onboarding complete. It looks things up on the web instead of asking you to explain tools or companies.
4. **Team page**: everyone in the org chart with their status:
   - **Not invited** — in the org chart, no login.
   - **Invited** — WorkOS emailed them an invitation; you can also copy the link and send it on WhatsApp.
   - **Joined** — they signed in. People are matched to their entry by email.

   Add people, change who they report to, invite or remove them (admins only).

The company profile is one markdown document per company, stored in Postgres. Its people section is generated from the `people` table.

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

The Chief of Staff's web search and page-reading tools run through AI Gateway (Parallel search and Browserbase fetch, a few dollars per thousand calls) and are billed to your AI Gateway credits, even when the model itself uses your own provider key.

### Deploy to Vercel

1. Import the repo; connect Neon from the Marketplace.
2. Add the WorkOS variables and `CHIEF_OF_STAFF_MODEL`. Set `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to `https://<your-domain>/callback` and add the same URL in WorkOS.
3. Run `pnpm db:migrate` against the production database once.

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
| `proxy.ts` | Requires sign-in on every route except `/callback` and `/sign-in` |
| `app/welcome/` | Create-your-company step |
| `app/(app)/page.tsx`, `components/onboarding.tsx` | Chief of Staff chat, live profile and onboarding checklist |
| `app/(app)/team/` | Team page and its server actions (add, set manager, invite, remove) |
| `app/api/chat/route.ts` | Streams the Chief of Staff's replies for the signed-in company |
| `lib/agents/chief-of-staff.ts` | Agent instructions and tools |
| `lib/session.ts` | Signed-in user, current company and their person record |
| `lib/people.ts`, `lib/orgs.ts`, `lib/profile/` | Data access for people, companies and the profile |
| `db/schema.sql` | Database schema |
