# Mach

A command center for running a small or medium-sized business, where people and AI agents work together in one place: a shared company profile and brain, a Chief of Staff agent coordinating worker agents, a Kanban board with automatic dispatch to agents, and agents reachable over WhatsApp and email.

Built in TypeScript on Vercel (Next.js, AI SDK, AI Gateway, Workflow, Sandbox, Connect), with WhatsApp via Twilio and email via Nodemailer.

- [Product specification (draft)](docs/spec.md)

## What works today: onboarding

Chat with the Chief of Staff and it interviews you about the company: what it does, the people, who reports to whom, goals, products, customers and how you work. As you talk it writes everything into a single markdown file, the company profile, shown live next to the chat.

- People are kept as a table (name, role, reports to, responsibilities, contact) with a generated reporting tree.
- Locally the profile is `data/company-profile.md`. On Vercel, connect a Blob store and it is saved to Vercel Blob instead.

## Run it locally

```bash
pnpm install
cp .env.example .env.local   # then fill in AI_GATEWAY_API_KEY and CHIEF_OF_STAFF_MODEL
pnpm dev
```

Open http://localhost:3000 and click **Start onboarding**. Delete `data/company-profile.md` to start over.

## Deploy to Vercel

1. Import the repo into Vercel.
2. Set `CHIEF_OF_STAFF_MODEL`. AI Gateway authenticates automatically on Vercel.
3. Connect a Blob store (Storage → Blob) so the profile persists; Vercel's filesystem is read-only.

## Checks

```bash
pnpm test        # unit tests, including the agent with a mock model
pnpm typecheck
pnpm lint
pnpm build
```

## Layout

| Path | What it is |
|---|---|
| `components/onboarding.tsx` | Chat UI and live profile preview |
| `app/api/chat/route.ts` | Streams the Chief of Staff's replies |
| `lib/agents/chief-of-staff.ts` | Agent instructions and profile-editing tools |
| `lib/profile/markdown.ts` | Read and rewrite profile sections and the people table |
| `lib/profile/store.ts` | Load and save the profile (local file or Vercel Blob) |
