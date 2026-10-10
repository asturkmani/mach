<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Mach1: chat first, screens second

People mostly use Mach1 by talking to their Chief of Staff on WhatsApp (and email, and the chat panel), not by clicking through screens. Design every feature for chat first: if someone can do it on a screen, they must be able to ask for it in chat, and get the answer, the file or the exact link back there. Screens are for seeing things at a glance, and for what must never go through chat.

- **Every action is declared once in `lib/actions`** (`tasks.ts`, `company.ts`, `research.ts`): name, one-line description, zod inputs, `who: "admin"` if admin-only. Server actions call `performAs(actorOf(ctx), name, input)`; the Chief of Staff gets the catalogue and runs any action with `do_action`. Don't write a new CoS tool for something a screen does, and don't put logic in a server action that the registry can't reach.
- **`lib/actions/coverage.test.ts` enforces it**: a new `app/**/actions.ts` export fails the test unless it goes through the registry, is one of the CoS's own tools, or is listed as screen-only with a reason. Don't add to the screen-only list to get green unless it truly can't be done from chat.
- **Who may do what lives in `lib/operations.ts`**, shared by screens and chat, so chat never does more than the person could in the app.
- **Never through chat, a model, a log or a thread**: credentials, passwords and API keys, deleting the company, linking WhatsApp. The CoS sends the exact link to the screen instead.
- **Every page has a `// @map Title | Where in the menus | What's there` line** at the top of its `page.tsx`; `npm run app-map` regenerates `lib/app-map.json` (the build does it too, and a test checks it). The CoS uses it to link the exact screen, never just the home page.
- **Write for a phone**: what the CoS says lands on WhatsApp, so replies, action results and errors are short plain sentences for the person, not developer messages.

More in `docs/assistant.md` ("Everything from chat").

# Environments and databases

- **Neon `dev` branch**: the development database. Coding sessions and local work use it (`DATABASE_URL`); it never syncs with production. If it drifts, reset it from `main` in the Neon console. Never point development work at production.
- **Neon `main` branch**: production, used only by Vercel production deployments.
- **Previews**: each branch's Vercel preview gets its own Neon branch, `preview/<branch>`. The Neon plan allows 10 branches; past that previews fail with "Resource provisioning failed". `.github/workflows/cleanup-merged-branches.yml` deletes a branch and its preview database when its pull request is merged (it never touches `main`, `dev` or `staging`).
- **Schema**: `db/schema.sql`, idempotent (`create … if not exists`, `alter … add column if not exists`), applied by `scripts/migrate.mjs` on every Vercel build (`vercel-build`), so a merge migrates production. Keep changes additive and safe for the code that's still running.
- **Flow**: feature branch → pull request → merge to `main`, which deploys production. Model ids aren't environment variables: they're per company by role (`lib/ai/lineup.ts`, `docs/ai-keys.md`).
