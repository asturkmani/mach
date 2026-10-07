import "server-only";

import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

import { getDb } from "@/lib/db";
import { redact, seal, unseal } from "@/lib/secrets";

// Integrations connect the company's other systems to Mach.
//
// - A data source (kind "api") is an HTTP API every agent (or chosen agents)
//   can call: through the call_api tool, or straight from code in a job's
//   sandbox, where the credentials are added to matching requests at the
//   network layer so they never enter the sandbox.
// - A login (kind "login") is a website account chosen agents use in a
//   browser (see lib/agents/browser-steps.ts).
//
// The Chief of Staff sets them up from the provider's docs; people enter the
// credentials in a form that goes straight to sealed storage, never through a
// model or the chat.

export type IntegrationKind = "api" | "login";
export type IntegrationStatus = "needs_credentials" | "connected" | "failing" | "disabled";

/** A value people enter when connecting: an API key, a client secret, a username. */
export type CredentialField = { name: string; label: string; secret?: boolean; optional?: boolean };

/**
 * How an API is called. Header, query and body values are templates:
 * "{{apiKey}}" is a credential field, "{{token}}" the access token from the
 * token step, and "{{basic:username:password}}" base64 of "username:password".
 */
export type ApiConfig = {
  baseUrl: string;
  /** Hosts requests may go to; the base URL's host by default. "*.example.com" matches subdomains. */
  domains: string[];
  fields: CredentialField[];
  headers?: Record<string, string>;
  /** Query parameters added to every request. Only call_api can add these, not sandbox code. */
  query?: Record<string, string>;
  /** For APIs that swap credentials for a short-lived access token first (OAuth client credentials, logins). */
  token?: {
    url: string;
    method?: "POST" | "GET";
    format?: "json" | "form";
    body?: Record<string, string>;
    headers?: Record<string, string>;
    /** Where the token is in the JSON response, e.g. "access_token" or "data.token". */
    path: string;
    /** Where its lifetime in seconds is, e.g. "expires_in". */
    expiresInPath?: string;
    /** Lifetime to assume when the response doesn't say. */
    ttlSeconds?: number;
  };
  /** A GET path that succeeds when the credentials work. */
  testPath?: string;
  docsUrl?: string;
};

/** A website account for browser work. */
export type LoginConfig = {
  loginUrl: string;
  domains: string[];
  fields: CredentialField[];
  /** A page that only shows when signed in; landing anywhere else means the session has expired. */
  checkUrl?: string;
  /** CSS selectors for the sign-in form, when the defaults don't find it. */
  selectors?: { username?: string; password?: string; submit?: string; code?: string };
  docsUrl?: string;
};

export type Integration = {
  id: string;
  kind: IntegrationKind;
  slug: string;
  name: string;
  description: string;
  config: ApiConfig | LoginConfig;
  access: "read" | "write";
  /** null: every agent. */
  agentIds: string[] | null;
  guide: string;
  status: IntegrationStatus;
  statusDetail: string;
  hasCredentials: boolean;
  /** A cached token (data source) or saved signed-in session (login). */
  hasSession: boolean;
  lastCheckedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

type Row = {
  id: string;
  kind: IntegrationKind;
  slug: string;
  name: string;
  description: string;
  config: ApiConfig | LoginConfig;
  access: "read" | "write";
  agent_ids: string[] | null;
  guide: string;
  status: IntegrationStatus;
  status_detail: string;
  has_credentials: boolean;
  has_session: boolean;
  last_checked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

const COLUMNS = `id, kind, slug, name, description, config, access, agent_ids, guide, status, status_detail,
  secrets is not null as has_credentials, session is not null as has_session, last_checked_at, last_used_at, created_at`;

const toIntegration = (r: Row): Integration => ({
  id: r.id,
  kind: r.kind,
  slug: r.slug,
  name: r.name,
  description: r.description,
  config: r.config,
  access: r.access,
  agentIds: r.agent_ids,
  guide: r.guide,
  status: r.status,
  statusDetail: r.status_detail,
  hasCredentials: r.has_credentials,
  hasSession: r.has_session,
  lastCheckedAt: r.last_checked_at,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
});

export class IntegrationError extends Error {}

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "integration";

/** Whether an agent may use an integration (null agent: a person, or the Chief of Staff). */
export const allowedFor = (integration: Pick<Integration, "agentIds">, agentId?: string | null) =>
  !agentId || !integration.agentIds || integration.agentIds.includes(agentId);

// ---------------------------------------------------------------------------
// Reading

export async function listIntegrations(organizationId: string, { agentId }: { agentId?: string | null } = {}): Promise<Integration[]> {
  const rows = await getDb().query<Row>(`select ${COLUMNS} from integrations where organization_id = $1 order by name`, [
    organizationId,
  ]);
  return rows.map(toIntegration).filter((i) => allowedFor(i, agentId));
}

export async function getIntegration(organizationId: string, slugOrId: string): Promise<Integration | null> {
  const isId = /^[0-9a-f-]{36}$/i.test(slugOrId);
  const [row] = await getDb().query<Row>(
    `select ${COLUMNS} from integrations where organization_id = $1 and ${isId ? "id = $2::uuid" : "slug = lower($2)"}`,
    [organizationId, slugOrId.trim()],
  );
  return row ? toIntegration(row) : null;
}

export type IntegrationCall = {
  method: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  taskNumber: number | null;
  agentName: string | null;
  personName: string | null;
  createdAt: Date;
};

export async function recentCalls(integrationId: string, limit = 15): Promise<IntegrationCall[]> {
  const rows = await getDb().query<{
    method: string;
    path: string;
    status: number | null;
    duration_ms: number | null;
    task_number: number | null;
    agent_name: string | null;
    person_name: string | null;
    created_at: Date;
  }>(
    `select c.method, c.path, c.status, c.duration_ms, t.number as task_number, a.name as agent_name, p.name as person_name, c.created_at
     from integration_calls c
     left join tasks t on t.id = c.task_id left join agents a on a.id = c.agent_id left join people p on p.id = c.person_id
     where c.integration_id = $1 order by c.created_at desc limit $2`,
    [integrationId, limit],
  );
  return rows.map((r) => ({
    method: r.method,
    path: r.path,
    status: r.status,
    durationMs: r.duration_ms,
    taskNumber: r.task_number,
    agentName: r.agent_name,
    personName: r.person_name,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Setting up

export type IntegrationInput = {
  kind: IntegrationKind;
  name: string;
  slug?: string;
  description?: string;
  config: ApiConfig | LoginConfig;
  access?: "read" | "write";
  agentIds?: string[] | null;
  guide?: string;
  personId?: string;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new IntegrationError(`${url} isn't a URL.`);
  }
}

/** Checks a config and fills in defaults (domains from the base or login URL). */
export function normalizeConfig(kind: IntegrationKind, config: ApiConfig | LoginConfig): ApiConfig | LoginConfig {
  const base = kind === "api" ? (config as ApiConfig).baseUrl : (config as LoginConfig).loginUrl;
  if (!base || !/^https:\/\//i.test(base)) throw new IntegrationError(`${kind === "api" ? "The base URL" : "The sign-in URL"} must start with https://.`);
  const domains = [...new Set([hostOf(base), ...(config.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)])];
  for (const d of domains) {
    if (!/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new IntegrationError(`${d} isn't a domain.`);
  }
  const fields = (config.fields ?? []).map((f) => ({
    name: f.name.trim(),
    label: f.label?.trim() || f.name,
    secret: f.secret ?? true,
    optional: f.optional ?? false,
  }));
  for (const f of fields) if (!/^[A-Za-z][\w]{0,39}$/.test(f.name)) throw new IntegrationError(`"${f.name}" isn't a usable field name.`);
  if (kind === "api") {
    const api = config as ApiConfig;
    // Every placeholder must be a field (or the token).
    const names = new Set([...fields.map((f) => f.name), "token"]);
    const templates = [
      ...Object.values(api.headers ?? {}),
      ...Object.values(api.query ?? {}),
      ...Object.values(api.token?.body ?? {}),
      ...Object.values(api.token?.headers ?? {}),
      api.token?.url ?? "",
    ];
    for (const t of templates) {
      for (const [, ref] of t.matchAll(/\{\{([^}]+)\}\}/g)) {
        const parts = ref.startsWith("basic:") ? ref.slice(6).split(":") : [ref];
        for (const part of parts) if (!names.has(part)) throw new IntegrationError(`{{${ref}}} doesn't match a credential field.`);
      }
    }
    if (api.token && !api.token.path) throw new IntegrationError("Say where the token is in the token response (path).");
    return { ...api, baseUrl: api.baseUrl.replace(/\/+$/, ""), domains, fields };
  }
  return { ...(config as LoginConfig), domains, fields };
}

/** Creates an integration, or updates the one with the same slug (keeping its credentials). */
export async function saveIntegration(organizationId: string, input: IntegrationInput): Promise<Integration> {
  const name = input.name.trim();
  if (!name) throw new IntegrationError("An integration needs a name.");
  const slug = slugify(input.slug || name);
  const config = normalizeConfig(input.kind, input.config);
  const [row] = await getDb().query<Row>(
    `insert into integrations (organization_id, kind, slug, name, description, config, access, agent_ids, guide, created_by_person_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid[], $9, $10)
     on conflict (organization_id, slug) do update set
       kind = excluded.kind, name = excluded.name,
       description = case when $5 = '' then integrations.description else excluded.description end,
       config = excluded.config, access = excluded.access,
       agent_ids = case when $11 then excluded.agent_ids else integrations.agent_ids end,
       guide = case when $9 = '' then integrations.guide else excluded.guide end,
       session = null, session_expires_at = null, updated_at = now()
     returning ${COLUMNS}`,
    [
      organizationId,
      input.kind,
      slug,
      name,
      input.description?.trim() ?? "",
      JSON.stringify(config),
      input.access ?? "read",
      input.agentIds ?? null,
      input.guide?.trim() ?? "",
      input.personId ?? null,
      input.agentIds !== undefined,
    ],
  );
  return toIntegration(row);
}

export async function updateIntegration(
  organizationId: string,
  id: string,
  patch: Partial<{ access: "read" | "write"; agentIds: string[] | null; guide: string; description: string; disabled: boolean }>,
): Promise<void> {
  const set: string[] = [];
  const params: unknown[] = [organizationId, id];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    set.push(sql.replace("?", `$${params.length}`));
  };
  if (patch.access) add("access = ?", patch.access);
  if (patch.agentIds !== undefined) add("agent_ids = ?::uuid[]", patch.agentIds);
  if (patch.guide !== undefined) add("guide = ?", patch.guide.trim());
  if (patch.description !== undefined) add("description = ?", patch.description.trim());
  if (patch.disabled !== undefined) {
    set.push(
      patch.disabled
        ? "status = 'disabled'"
        : "status = case when secrets is null then 'needs_credentials' else 'connected' end",
    );
  }
  if (!set.length) return;
  await getDb().query(`update integrations set ${set.join(", ")}, updated_at = now() where organization_id = $1 and id = $2`, params);
}

export async function deleteIntegration(organizationId: string, id: string): Promise<void> {
  await getDb().query("delete from integrations where organization_id = $1 and id = $2", [organizationId, id]);
}

type Secrets = Record<string, string>;

/** Stores credentials (sealed). Fields left blank keep their saved value, so one key can be rotated alone. */
export async function saveCredentials(organizationId: string, id: string, values: Secrets): Promise<Integration> {
  const integration = await getIntegration(organizationId, id);
  if (!integration) throw new IntegrationError("That integration doesn't exist.");
  const previous = await readSecrets(organizationId, integration.id).catch(() => ({}) as Secrets);
  const next: Secrets = { ...previous };
  for (const field of integration.config.fields) {
    const value = values[field.name]?.trim();
    if (value) next[field.name] = value;
    if (!next[field.name] && !field.optional) throw new IntegrationError(`Enter ${field.label}.`);
  }
  await getDb().query(
    `update integrations set secrets = $3, session = null, session_expires_at = null, status = 'connected', status_detail = '', updated_at = now()
     where organization_id = $1 and id = $2`,
    [organizationId, integration.id, seal(next)],
  );
  // Anything pasted into a chat or a thread by mistake is scrubbed there too.
  await scrubConversations(organizationId, Object.values(next));
  return (await getIntegration(organizationId, integration.id))!;
}

async function readSecrets(organizationId: string, id: string): Promise<Secrets> {
  const [row] = await getDb().query<{ secrets: Uint8Array | null }>(
    "select secrets from integrations where organization_id = $1 and id = $2",
    [organizationId, id],
  );
  if (!row?.secrets) throw new IntegrationError("Its credentials haven't been entered yet.");
  return unseal<Secrets>(row.secrets);
}

/** Replaces secret values that ended up in this company's chats or task threads. */
export async function scrubConversations(organizationId: string, secrets: string[]): Promise<void> {
  const db = getDb();
  for (const secret of secrets.filter((s) => s && s.length >= 8)) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      await db.query(
        `update chats set messages = replace(messages::text, $2, '[secret]')::jsonb
         where organization_id = $1 and position($2 in messages::text) > 0`,
        [organizationId, form],
      );
    }
    await db.query(
      `update task_messages set body = replace(body, $2, '[secret]')
       where position($2 in body) > 0 and task_id in (select id from tasks where organization_id = $1)`,
      [organizationId, secret],
    );
  }
}

/** A login's credentials and saved browser session (Playwright storage state), for the sign-in helper only. */
export async function readLogin(
  organizationId: string,
  id: string,
): Promise<{ secrets: Secrets; session: string | null; landingUrl: string | null }> {
  const [row] = await getDb().query<{ secrets: Uint8Array | null; session: Uint8Array | null }>(
    "select secrets, session from integrations where organization_id = $1 and id = $2 and kind = 'login'",
    [organizationId, id],
  );
  if (!row?.secrets) throw new IntegrationError("Its credentials haven't been entered yet.");
  const session = row.session ? unseal<{ state: string; landingUrl?: string }>(row.session) : null;
  return { secrets: unseal<Secrets>(row.secrets), session: session?.state ?? null, landingUrl: session?.landingUrl ?? null };
}

/** Keeps a signed-in browser session (sealed), so later runs and jobs skip the sign-in. */
export async function saveLoginSession(organizationId: string, slug: string, state: string, landingUrl?: string): Promise<void> {
  await getDb().query(
    `update integrations set session = $3, session_expires_at = null, last_used_at = now(),
       status = case when status = 'disabled' then status else 'connected' end,
       status_detail = case when status = 'disabled' then status_detail else 'Signed in; the session is saved.' end
     where organization_id = $1 and slug = $2 and kind = 'login'`,
    [organizationId, slug, seal({ state, landingUrl })],
  );
}

export async function setLoginStatus(organizationId: string, slug: string, status: IntegrationStatus, detail: string): Promise<void> {
  const [row] = await getDb().query<{ id: string }>("select id from integrations where organization_id = $1 and slug = $2", [
    organizationId,
    slug,
  ]);
  if (row) await setStatus(row.id, status, detail);
}

/** Forgets a login's saved session, so the next sign-in starts afresh. */
export async function forgetSession(organizationId: string, id: string): Promise<void> {
  await getDb().query(
    `update integrations set session = null, session_expires_at = null,
       status_detail = case when kind = 'login' then 'Session forgotten; signs in again next time.' else status_detail end
     where organization_id = $1 and id = $2`,
    [organizationId, id],
  );
}

async function setStatus(id: string, status: IntegrationStatus, detail = ""): Promise<void> {
  await getDb().query(
    "update integrations set status = $2, status_detail = $3, last_checked_at = now(), updated_at = now() where id = $1 and status <> 'disabled'",
    [id, status, detail.slice(0, 300)],
  );
}

// ---------------------------------------------------------------------------
// Calling

/** Fills "{{field}}", "{{token}}" and "{{basic:a:b}}" placeholders. */
export function fill(template: string, values: Secrets): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, ref: string) => {
    if (ref.startsWith("basic:")) {
      const [a, b] = ref.slice(6).split(":");
      return Buffer.from(`${values[a] ?? ""}:${values[b] ?? ""}`).toString("base64");
    }
    if (values[ref] === undefined) throw new IntegrationError(`No value for {{${ref}}}.`);
    return values[ref];
  });
}

const fillAll = (templates: Record<string, string> | undefined, values: Secrets) =>
  Object.fromEntries(Object.entries(templates ?? {}).map(([k, v]) => [k, fill(v, values)]));

const dig = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined), value);

const usesToken = (config: ApiConfig) =>
  Boolean(config.token) &&
  [...Object.values(config.headers ?? {}), ...Object.values(config.query ?? {})].some((t) => t.includes("{{token}}"));

/** A cached access token, or a fresh one from the token step. */
async function accessToken(organizationId: string, integration: Integration, secrets: Secrets): Promise<string> {
  const config = integration.config as ApiConfig;
  const [cached] = await getDb().query<{ session: Uint8Array | null; session_expires_at: Date | null }>(
    "select session, session_expires_at from integrations where id = $1",
    [integration.id],
  );
  // Reuse a token with at least ten minutes left, so a sandbox run that took it keeps working.
  if (cached?.session && cached.session_expires_at && new Date(cached.session_expires_at).getTime() - Date.now() > 10 * 60_000) {
    return unseal<{ token: string }>(cached.session).token;
  }
  const step = config.token!;
  const headers: Record<string, string> = { accept: "application/json", ...fillAll(step.headers, secrets) };
  const body = fillAll(step.body, secrets);
  let payload: string | undefined;
  if ((step.method ?? "POST") === "POST") {
    if (step.format === "form") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(body).toString();
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const response = await fetch(fill(step.url, secrets), {
    method: step.method ?? "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = `Getting an access token failed (${response.status}): ${redact(text, Object.values(secrets)).slice(0, 200)}`;
    await setStatus(integration.id, "failing", detail);
    throw new IntegrationError(detail);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new IntegrationError("The token response wasn't JSON.");
  }
  const token = dig(json, step.path);
  if (typeof token !== "string" || !token) throw new IntegrationError(`No token at "${step.path}" in the token response.`);
  const seconds = Number((step.expiresInPath && dig(json, step.expiresInPath)) || step.ttlSeconds || 3600);
  await getDb().query("update integrations set session = $2, session_expires_at = $3 where id = $1", [
    integration.id,
    seal({ token }),
    new Date(Date.now() + seconds * 1000),
  ]);
  return token;
}

/** The headers and query parameters that sign a request, with every value used (for redaction). */
async function signing(organizationId: string, integration: Integration) {
  const config = integration.config as ApiConfig;
  const secrets = await readSecrets(organizationId, integration.id);
  const values: Secrets = { ...secrets };
  if (usesToken(config)) values.token = await accessToken(organizationId, integration, secrets);
  return {
    headers: fillAll(config.headers, values),
    query: fillAll(config.query, values),
    secrets: Object.values(values),
  };
}

export const matchesDomain = (host: string, domains: string[]) =>
  domains.some((d) => (d.startsWith("*.") ? host.endsWith(d.slice(1)) || host === d.slice(2) : host === d));

export type CallRequest = {
  method?: string;
  /** A path under the base URL, or a full URL on one of its domains. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
};

export type CallResult = { status: number; contentType: string; body: Buffer; text: string; url: string };

/** Who is calling, for the activity log and the agent's access. */
export type Caller = { taskId?: string; agentId?: string; personId?: string };

/**
 * Calls a data source on someone's behalf: checks access, signs the request
 * and logs it. Secret values are scrubbed from the response text.
 */
export async function callIntegration(
  organizationId: string,
  slugOrId: string,
  request: CallRequest,
  caller: Caller = {},
): Promise<CallResult> {
  const integration = await getIntegration(organizationId, slugOrId);
  if (!integration || integration.kind !== "api") throw new IntegrationError(`There's no data source called ${slugOrId}.`);
  if (!allowedFor(integration, caller.agentId)) throw new IntegrationError(`You don't have access to ${integration.name}.`);
  if (integration.status === "disabled") throw new IntegrationError(`${integration.name} is turned off.`);
  if (integration.status === "needs_credentials") throw new IntegrationError(`${integration.name}'s credentials haven't been entered yet.`);
  const config = integration.config as ApiConfig;
  const method = (request.method ?? "GET").toUpperCase();
  if (integration.access === "read" && !["GET", "HEAD"].includes(method)) {
    throw new IntegrationError(`${integration.name} is read-only here: only GET requests are allowed.`);
  }

  const url = /^https?:\/\//i.test(request.path)
    ? new URL(request.path)
    : new URL(`${config.baseUrl}/${request.path.replace(/^\/+/, "")}`);
  if (url.protocol !== "https:" || !matchesDomain(url.hostname, config.domains)) {
    throw new IntegrationError(`${url.hostname} isn't one of ${integration.name}'s domains (${config.domains.join(", ")}).`);
  }
  const sign = await signing(organizationId, integration);
  for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(request.query ?? {}).map(([k, v]) => [k, String(v)])), ...sign.query })) {
    url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { accept: "application/json", ...(request.headers ?? {}), ...sign.headers };
  let body: string | undefined;
  if (request.body !== undefined && !["GET", "HEAD"].includes(method)) {
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (typeof request.body !== "string") headers["content-type"] ??= "application/json";
  }

  const started = Date.now();
  let status: number | null = null;
  try {
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    status = response.status;
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const textual = /json|text|xml|csv|javascript/i.test(contentType) || !contentType;
    const text = textual ? redact(bytes.toString("utf8"), sign.secrets) : "";
    if (status === 401 || status === 403) {
      await setStatus(integration.id, "failing", `${integration.name} refused the credentials (${status}).`);
    } else if (response.ok && integration.status === "failing") {
      await setStatus(integration.id, "connected");
    }
    // Shown without query values, which can hold keys.
    const shown = new URL(url);
    shown.search = "";
    return { status, contentType, body: textual ? Buffer.from(text) : bytes, text, url: shown.toString() };
  } finally {
    await getDb().query(
      `insert into integration_calls (integration_id, task_id, agent_id, person_id, method, path, status, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [integration.id, caller.taskId ?? null, caller.agentId ?? null, caller.personId ?? null, method, url.pathname.slice(0, 300), status, Date.now() - started],
    );
    await getDb().query("update integrations set last_used_at = now() where id = $1", [integration.id]);
  }
}

/** Calls the test path and records whether the connection works. */
export async function testIntegration(organizationId: string, id: string): Promise<Integration> {
  const integration = await getIntegration(organizationId, id);
  if (!integration) throw new IntegrationError("That integration doesn't exist.");
  if (integration.kind !== "api") {
    // A login is checked by signing in, which happens in an agent's browser the first time it's used.
    await setStatus(integration.id, "connected", "Credentials saved; it signs in the first time it’s used.");
    return (await getIntegration(organizationId, integration.id))!;
  }
  const config = integration.config as ApiConfig;
  try {
    if (config.testPath) {
      const result = await callIntegration(organizationId, integration.id, { path: config.testPath });
      if (result.status >= 200 && result.status < 300) await setStatus(integration.id, "connected", `GET ${config.testPath} returned ${result.status}.`);
      else await setStatus(integration.id, "failing", `GET ${config.testPath} returned ${result.status}: ${result.text.slice(0, 160)}`);
    } else {
      // Nothing to call: at least check a token can be had.
      await signing(organizationId, integration);
      await setStatus(integration.id, "connected", "Credentials saved; there's no test request.");
    }
  } catch (error) {
    await setStatus(integration.id, "failing", error instanceof Error ? error.message : "The test failed.");
  }
  return (await getIntegration(organizationId, integration.id))!;
}

/**
 * Every credential value (and cached token) the company has stored, so
 * anything an agent reads back from its sandbox can be scrubbed: an API that
 * echoes its key would otherwise put it in front of the model.
 */
export async function knownSecrets(organizationId: string): Promise<string[]> {
  const rows = await getDb().query<{ config: ApiConfig | LoginConfig; secrets: Uint8Array | null; session: Uint8Array | null }>(
    "select config, secrets, session from integrations where organization_id = $1 and (secrets is not null or session is not null)",
    [organizationId],
  );
  const values: string[] = [];
  for (const row of rows) {
    try {
      // Only fields marked secret: a login's username, say, can show on pages agents read.
      const secretFields = new Set(row.config.fields.filter((f) => f.secret !== false).map((f) => f.name));
      if (row.secrets) {
        for (const [name, value] of Object.entries(unseal<Secrets>(row.secrets))) if (secretFields.has(name)) values.push(value);
      }
      if (row.session) {
        const session = unseal<{ token?: string }>(row.session);
        if (typeof session.token === "string") values.push(session.token);
      }
    } catch (error) {
      console.error("Couldn't read stored credentials", error);
    }
  }
  return values.filter((v) => typeof v === "string" && v.length >= 6);
}

// ---------------------------------------------------------------------------
// Sandboxes

/**
 * The network policy for a job's sandbox: requests to each data source the
 * agent may use get its auth headers added on the way out (and read-only
 * ones are refused anything but GET), while everything else is allowed as
 * before. Credentials never enter the sandbox. Query-parameter keys can't be
 * added this way; those sources work through call_api only.
 */
export async function sandboxPolicy(organizationId: string, agentId: string | null): Promise<{ policy: NetworkPolicy; sources: string[] }> {
  const sources = (await listIntegrations(organizationId, { agentId })).filter(
    (i) => i.kind === "api" && i.status !== "disabled" && i.hasCredentials,
  );
  const allow: Record<string, NetworkPolicyRule[]> = {};
  const used: string[] = [];
  for (const source of sources) {
    let headers: Record<string, string>;
    try {
      headers = (await signing(organizationId, source)).headers;
    } catch (error) {
      console.error(`Couldn't sign requests for ${source.slug}`, error);
      continue;
    }
    if (!Object.keys(headers).length) continue;
    const rules: NetworkPolicyRule[] =
      source.access === "read"
        ? [
            { match: { method: ["GET", "HEAD"] }, transform: [{ headers }] },
            {
              response: {
                statusCode: 403,
                contentType: "text/plain",
                body: `Mach: ${source.name} is read-only, so only GET requests are allowed.`,
              },
            },
          ]
        : [{ transform: [{ headers }] }];
    for (const domain of (source.config as ApiConfig).domains) allow[domain] ??= rules;
    used.push(source.slug);
  }
  if (!used.length) return { policy: "allow-all", sources: [] };
  allow["*"] = [];
  return { policy: { allow }, sources: used };
}
