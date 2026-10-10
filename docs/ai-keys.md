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

Which model runs: an agent's own model, else the company's default for agents, else Mach1's defaults
(`CODING_AGENT_MODEL` for the Developer, `AGENT_MODEL`, `CHIEF_OF_STAFF_MODEL`). The Chief of Staff: the
company's choice, else `CHIEF_OF_STAFF_MODEL`. Voice notes are still transcribed on Mach1's account.

## Code

| File | |
| --- | --- |
| `lib/ai/keys.ts` | Providers, checking and storing keys, the BYOK option |
| `lib/ai/gateway-steps.ts` | What AI Gateway is told with each call |
| `lib/ai/company-model.ts` | `CompanyModel`, used by every model call |
| `app/(app)/settings/ai`, `components/ai-settings.tsx` | Settings → AI |
