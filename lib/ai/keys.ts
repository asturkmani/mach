import "server-only";

import { gateway, generateText } from "ai";

import { getDb } from "@/lib/db";
import { seal, unseal } from "@/lib/secrets";

// Bring your own key: a company's own accounts with AI providers. An admin
// adds a key in Settings → AI (never in a chat); it's checked with the
// provider and with a test call through AI Gateway, sealed, and from then on every model call made for the company
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
  if (response.ok) return;
  const reason = providerMessage(await response.text().catch(() => ""), apiKey);
  // Anthropic's organisation-wide keys need a workspace named on every request, which AI Gateway can't pass.
  if (/not scoped to a workspace/i.test(reason)) {
    throw new AiKeyError(
      "This key isn't tied to a workspace. In the Anthropic console, open Settings → Workspaces, pick a workspace (Default is fine), create the key there and paste that one.",
    );
  }
  if (response.status === 401 || response.status === 403) throw new AiKeyError(`The provider didn't accept that key${reason ? `: ${reason}` : "."}`);
  throw new AiKeyError(`The provider said ${response.status} when checking the key${reason ? `: ${reason}` : "."}`);
}

/** The provider's own words about what's wrong ({ error: { message } } or { error: "…" }), never including the key. */
function providerMessage(body: string, apiKey: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? "";
  } catch {
    message = body;
  }
  return message.split(apiKey).join("[the key]").replace(/\s+/g, " ").trim().slice(0, 400);
}

type Attempt = { credentialType?: string; success?: boolean; error?: string };

/**
 * Makes one tiny call through AI Gateway with only this key, on the
 * provider's cheapest model, and returns the model when the key itself
 * served it (AI Gateway would otherwise quietly fall back to Mach1's).
 */
async function checkThroughGateway(provider: string, apiKey: string): Promise<string> {
  const { models } = await gateway.getAvailableModels();
  const price = (m: (typeof models)[number]) => Number(m.pricing?.input ?? Infinity);
  const cheapest = models
    .filter((m) => m.id.startsWith(`${provider}/`) && (!m.modelType || m.modelType === "language") && Number.isFinite(price(m)))
    .sort((a, b) => price(a) - price(b))[0];
  if (!cheapest) throw new AiKeyError(`AI Gateway has no ${provider} model to check the key with.`);
  const result = await generateText({
    model: cheapest.id,
    prompt: "Reply with the word ok.",
    maxOutputTokens: 16,
    maxRetries: 0,
    providerOptions: { gateway: { byok: { [provider]: [{ apiKey }] } } },
  });
  const routing = (result.providerMetadata?.gateway as { routing?: { modelAttempts?: { providerAttempts?: Attempt[] }[] } } | undefined)?.routing;
  const own = (routing?.modelAttempts ?? []).flatMap((a) => a.providerAttempts ?? []).filter((a) => a.credentialType === "byok");
  if (own.some((a) => a.success)) return cheapest.id;
  throw new AiKeyError(`AI Gateway couldn't use the key${own[0]?.error ? ` (${own[0].error})` : ""}.`);
}

let gatewayCheck = checkThroughGateway;
/** Tests stand in for AI Gateway. */
export function setGatewayCheck(check: typeof checkThroughGateway | null): void {
  gatewayCheck = check ?? checkThroughGateway;
}

/**
 * Saves the company's key for a provider once it's proved to work: the
 * provider accepts it, and a test call through AI Gateway is served with it.
 * Returns the key and the model the test call ran on.
 */
export async function saveAiKey(
  organizationId: string,
  provider: string,
  apiKey: string,
  addedBy: string | null,
): Promise<AiKey & { testedOn: string }> {
  if (!AI_PROVIDERS.some((p) => p.slug === provider)) throw new AiKeyError("Unknown provider.");
  const key = apiKey.trim();
  if (key.length < 20 || /\s/.test(key)) throw new AiKeyError("That doesn't look like an API key.");
  await checkKey(provider, key);
  let testedOn: string;
  try {
    testedOn = await gatewayCheck(provider, key);
  } catch (error) {
    if (error instanceof AiKeyError) throw error;
    throw new AiKeyError(`The test call through AI Gateway failed: ${(error as Error).message.slice(0, 200)}`);
  }
  const [row] = await getDb().query<{ provider: string; hint: string; created_at: Date }>(
    `insert into ai_keys (organization_id, provider, secrets, hint, added_by_person_id) values ($1, $2, $3, $4, $5)
     on conflict (organization_id, provider) do update set secrets = excluded.secrets, hint = excluded.hint,
       added_by_person_id = excluded.added_by_person_id, created_at = now()
     returning provider, hint, created_at`,
    [organizationId, provider, seal({ apiKey: key }), key.slice(-4), addedBy],
  );
  return { provider: row.provider, hint: row.hint, createdAt: row.created_at, testedOn };
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
