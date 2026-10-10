import "server-only";

import { getDb } from "@/lib/db";
import { seal, unseal } from "@/lib/secrets";

// Bring your own key: a company's own accounts with AI providers. An admin
// adds a key in Settings → AI (never in a chat); it's checked with the
// provider, sealed, and from then on every model call made for the company
// carries it to AI Gateway for that request (company-model.ts), so the
// provider bills the company. If a key stops working, AI Gateway falls back
// to Mach1's own credentials rather than failing the work.

export type AiProvider = { slug: string; name: string; placeholder: string; keysUrl: string };

/** The providers a company can bring a key for: AI Gateway's slugs, which are also the first part of model ids. */
export const AI_PROVIDERS: AiProvider[] = [
  { slug: "anthropic", name: "Anthropic", placeholder: "sk-ant-…", keysUrl: "https://console.anthropic.com/settings/keys" },
  { slug: "openai", name: "OpenAI", placeholder: "sk-…", keysUrl: "https://platform.openai.com/api-keys" },
  { slug: "google", name: "Google (Gemini)", placeholder: "AIza…", keysUrl: "https://aistudio.google.com/apikey" },
  { slug: "xai", name: "xAI", placeholder: "xai-…", keysUrl: "https://console.x.ai" },
];

export const providerOf = (modelId: string) => modelId.split("/")[0] ?? "";

export type AiKey = { provider: string; hint: string; createdAt: Date };

export async function listAiKeys(organizationId: string): Promise<AiKey[]> {
  const rows = await getDb().query<{ provider: string; hint: string; created_at: Date }>(
    "select provider, hint, created_at from ai_keys where organization_id = $1 order by provider",
    [organizationId],
  );
  return rows.map((r) => ({ provider: r.provider, hint: r.hint, createdAt: r.created_at }));
}

export class AiKeyError extends Error {}

/** Asks the provider whether the key works, by listing its models: free, and no model call. */
async function checkKey(provider: string, apiKey: string): Promise<void> {
  const request: Record<string, { url: string; headers: Record<string, string> }> = {
    anthropic: { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    openai: { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } },
    google: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": apiKey } },
    xai: { url: "https://api.x.ai/v1/models", headers: { Authorization: `Bearer ${apiKey}` } },
  };
  const { url, headers } = request[provider];
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AiKeyError("Couldn't reach the provider to check the key. Try again.");
  }
  if (response.status === 401 || response.status === 403) throw new AiKeyError("The provider didn't accept that key.");
  if (!response.ok) throw new AiKeyError(`The provider said ${response.status} when checking the key.`);
}

export async function saveAiKey(organizationId: string, provider: string, apiKey: string, addedBy: string | null): Promise<AiKey> {
  if (!AI_PROVIDERS.some((p) => p.slug === provider)) throw new AiKeyError("Unknown provider.");
  const key = apiKey.trim();
  if (key.length < 20 || /\s/.test(key)) throw new AiKeyError("That doesn't look like an API key.");
  await checkKey(provider, key);
  const [row] = await getDb().query<{ provider: string; hint: string; created_at: Date }>(
    `insert into ai_keys (organization_id, provider, secrets, hint, added_by_person_id) values ($1, $2, $3, $4, $5)
     on conflict (organization_id, provider) do update set secrets = excluded.secrets, hint = excluded.hint,
       added_by_person_id = excluded.added_by_person_id, created_at = now()
     returning provider, hint, created_at`,
    [organizationId, provider, seal({ apiKey: key }), key.slice(-4), addedBy],
  );
  return { provider: row.provider, hint: row.hint, createdAt: row.created_at };
}

export async function removeAiKey(organizationId: string, provider: string): Promise<void> {
  await getDb().query("delete from ai_keys where organization_id = $1 and provider = $2", [organizationId, provider]);
}

/** The company's keys as AI Gateway's request-scoped BYOK option: { anthropic: [{ apiKey }] }. */
export async function byokCredentials(organizationId: string): Promise<Record<string, { apiKey: string }[]>> {
  const rows = await getDb().query<{ provider: string; secrets: Uint8Array }>("select provider, secrets from ai_keys where organization_id = $1", [
    organizationId,
  ]);
  const byok: Record<string, { apiKey: string }[]> = {};
  for (const row of rows) {
    try {
      byok[row.provider] = [{ apiKey: unseal<{ apiKey: string }>(row.secrets).apiKey }];
    } catch (error) {
      console.error(`Couldn't read the company's ${row.provider} key`, (error as Error).message);
    }
  }
  return byok;
}
