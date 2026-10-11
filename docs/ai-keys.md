# Bring your own key

A company can run its Chief of Staff and agents on its own accounts with AI providers, so model usage is
billed to it directly, and choose which models they run on.

## For admins

Settings → AI:

- **Your AI keys**: a key for Anthropic, OpenAI, Google (Gemini) or xAI. Before it's kept it's checked
  with the provider (by listing its models) and then with one tiny call through AI Gateway on the
  provider's cheapest model, which must be served by the key itself (AI Gateway reports which credential
  served each call), so a key AI Gateway would quietly skip is refused. It's stored encrypted (`ai_keys`, sealed with `MACH_SECRETS_KEY`),
  shown only by its last four characters, and never given to a model, a chat or a sandbox. Typed into the
  page, never into a chat. An xAI key also pays for the company's X searches when Mach1 has no X API app (and
  Reddit searches without a Reddit app), which Mach1 makes on xAI's API directly (docs/research.md).
- **Default models**: the company's own model for the Chief of Staff and for agents (each agent can still
  have its own, on its page). Pick models from a provider you brought a key for; the page says when some
  of the company's models are from a provider without one (those run on Mach1's account).

## How it works

Every model call made for a company goes through `CompanyModel` (`lib/ai/company-model.ts`): an AI Gateway
model that, at the moment of the call, adds the company's keys as AI Gateway's request-scoped BYOK option
(`providerOptions.gateway.byok`) and tags the usage with the company (`user`, `tags: ["org:<id>"]`), so
spend can be reported per company in AI Gateway even without keys.

- AI Gateway tries the company's key first. If it fails (revoked, out of credit), it falls back to Mach1's
  credentials rather than failing the work.
- With a company key for a provider, the Vercel team's own BYOK credentials for that provider are ignored.
- Task agents run in durable workflows, which record every step's inputs. A `CompanyModel` is recorded as
  just its company and model ids (`WORKFLOW_SERIALIZE`); the key is read inside the model call
  (`companyGatewayOptions`, a step that runs inline there) and never stored.

## Which model runs

An agent's own model, else the company's default for agents, else Mach1's for its role; the Chief of Staff:
the company's choice, else Mach1's. Mach1's come in two lineups (`lib/ai/lineup.ts`), Claude when the
company brought an Anthropic key, else OpenAI on Mach1's account:

| Role | Claude (Anthropic key) | OpenAI |
| --- | --- | --- |
| Chief of Staff (`chat`) | Haiku 5.5, no thinking | GPT-6 Luna Fast, low reasoning |
| Agents, skills that need code (`model: coder`), browser (`worker`, `coder`, `browser`) | Sonnet 5.5, medium thinking | GPT-6.1 Sol, medium (browser: GPT-6 Astra) |
| Running jobs: the Coordinator (`planner`) | Opus 5.5, high | GPT-6 Astra, high |
| Summaries, page ideas (`background`) | Haiku 5.5 | GPT-6 Luna |

A role is stored as `mach1/<role>` and resolved in each model call (`CompanyModel`), so adding or removing
a key changes the models at once. Each family's thinking setting is applied to any model of it, chosen or
not, unless the call sets its own. Role calls name the other lineup's model as AI Gateway's fallback, and
ask it to cache the prompt (`caching: "auto"`; Claude needs it, OpenAI caches anyway). The Chief of Staff
tells an admin once that adding an Anthropic key runs Claude. Mach1's own account can carry the Vercel
team's OpenAI key (AI Gateway → BYOK in the Vercel dashboard), so the OpenAI lineup bills it. Voice notes
are transcribed on Mach1's account (`TRANSCRIPTION_MODEL`, Grok STT by default).

Chosen in October 2026 by timing whole WhatsApp turns on the Chief of Staff's real prompt (13k tokens):
Haiku 5.5 2.0s median (15/15 right), GPT-6 Luna Fast 2.3s, GPT-6.1 Sol 3.9s; open models on fast hosts
(Cerebras, Groq, Fireworks) were fast per step but missed tool calls or took more steps.

## Code

| File | |
| --- | --- |
| `lib/ai/keys.ts` | Providers, checking and storing keys, the BYOK option |
| `lib/ai/gateway-steps.ts` | What AI Gateway is told with each call |
| `lib/ai/company-model.ts` | `CompanyModel`, used by every model call |
| `app/(app)/settings/ai`, `components/ai-settings.tsx` | Settings → AI |
