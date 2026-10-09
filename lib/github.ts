import "server-only";

import { getDb } from "@/lib/db";
import { seal, unseal } from "@/lib/secrets";

// Each person's own GitHub account, connected through Mach1's GitHub App
// (docs/github.md). It's theirs alone: it signs the Chief of Staff's GitHub
// calls while it talks with them, and the sandbox of a task run they asked
// for. Nobody else's work can use it. Tokens are user access tokens (they
// act as the person, within the repositories the person let the app reach):
// they last 8 hours and renew themselves with a refresh token that lasts 6
// months. They're sealed at rest and never enter a sandbox or a model.

const OAUTH = "https://github.com/login/oauth";
const API = "https://api.github.com";

type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null; refreshExpiresAt: number | null };
export type GitHubAccount = { id: string; login: string; name: string };
export type GitHubConnection = GitHubAccount & { status: "connected" | "expired"; connectedAt: Date };

export class GitHubError extends Error {}

export const githubConfigured = () => Boolean(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);

/** Where people choose which repositories Mach1 may use (installing the app on their account or organization). */
export const githubInstallUrl = () =>
  process.env.GITHUB_APP_SLUG ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new` : null;

/** The cookie that ties GitHub's answer to the browser that asked (see app/connect/github). */
export const GITHUB_STATE_COOKIE = "mach-github-connect";

/** Where GitHub sends people back: it must match the app's callback URL. */
export const githubRedirectUri = (requestUrl: string) =>
  process.env.GITHUB_APP_REDIRECT_URI ?? new URL("/connect/github/callback", requestUrl).href;

/** GitHub's page asking the person to let Mach1 act for them. */
export function githubAuthorizeUrl(state: string, redirectUri: string): string {
  const query = new URLSearchParams({ client_id: process.env.GITHUB_APP_CLIENT_ID!, redirect_uri: redirectUri, state, allow_signup: "false" });
  return `${OAUTH}/authorize?${query}`;
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${OAUTH}/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_APP_CLIENT_ID, client_secret: process.env.GITHUB_APP_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) throw new GitHubError(body.error_description || body.error || `GitHub said ${response.status}.`);
  const now = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
    refreshExpiresAt: body.refresh_token_expires_in ? now + body.refresh_token_expires_in * 1000 : null,
  };
}

/** Swaps the code GitHub sent back for the person's tokens. */
export const exchangeGitHubCode = (code: string, redirectUri: string) => tokenRequest({ code, redirect_uri: redirectUri });

export async function githubAccount(accessToken: string): Promise<GitHubAccount> {
  const response = await fetch(`${API}/user`, { headers: apiHeaders(accessToken), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new GitHubError(`GitHub didn't say who this is (${response.status}).`);
  const user = (await response.json()) as { id: number; login: string; name: string | null };
  return { id: String(user.id), login: user.login, name: user.name ?? "" };
}

const apiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Mach1",
});

type Row = {
  account_id: string;
  account_login: string;
  account_name: string;
  secrets: Uint8Array;
  status: "connected" | "expired";
  created_at: Date;
};

export async function saveGitHubConnection(organizationId: string, personId: string, tokens: Tokens, account: GitHubAccount): Promise<void> {
  await getDb().query(
    `insert into personal_connections (organization_id, person_id, provider, account_id, account_login, account_name, secrets)
     values ($1, $2, 'github', $3, $4, $5, $6)
     on conflict (person_id, provider) do update set
       account_id = excluded.account_id, account_login = excluded.account_login, account_name = excluded.account_name,
       secrets = excluded.secrets, status = 'connected', updated_at = now()`,
    [organizationId, personId, account.id, account.login, account.name, seal(tokens)],
  );
}

async function readRow(organizationId: string, personId: string): Promise<Row | null> {
  const [row] = await getDb().query<Row>(
    `select account_id, account_login, account_name, secrets, status, created_at from personal_connections
     where organization_id = $1 and person_id = $2 and provider = 'github'`,
    [organizationId, personId],
  );
  return row ?? null;
}

/** The person's GitHub account, if they connected one (no tokens). */
export async function getGitHubConnection(organizationId: string, personId: string): Promise<GitHubConnection | null> {
  const row = await readRow(organizationId, personId);
  return row
    ? { id: row.account_id, login: row.account_login, name: row.account_name, status: row.status, connectedAt: row.created_at }
    : null;
}

/** How commits made for this person are signed: their name and GitHub's private address for them. */
export const commitIdentity = (account: GitHubAccount) => ({
  name: account.name || account.login,
  email: `${account.id}+${account.login}@users.noreply.github.com`,
});

const RENEW_EARLY_MS = 10 * 60_000;

/**
 * A working access token for this person's GitHub, renewed if it's about to
 * run out. Null when they haven't connected GitHub, or it can't be renewed
 * (they revoked it, or six months passed): then they connect it again.
 */
export async function githubToken(organizationId: string, personId: string): Promise<{ token: string; account: GitHubAccount } | null> {
  const row = await readRow(organizationId, personId);
  if (!row || row.status !== "connected") return null;
  const account = { id: row.account_id, login: row.account_login, name: row.account_name };
  let tokens: Tokens;
  try {
    tokens = unseal<Tokens>(row.secrets);
  } catch (error) {
    console.error("Couldn't read a GitHub connection", error);
    return null;
  }
  if (!tokens.expiresAt || tokens.expiresAt - RENEW_EARLY_MS > Date.now()) return { token: tokens.accessToken, account };
  if (!tokens.refreshToken || (tokens.refreshExpiresAt && tokens.refreshExpiresAt < Date.now())) {
    await markExpired(organizationId, personId);
    return null;
  }
  try {
    const renewed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    await getDb().query(
      "update personal_connections set secrets = $3, updated_at = now() where organization_id = $1 and person_id = $2 and provider = 'github'",
      [organizationId, personId, seal(renewed)],
    );
    return { token: renewed.accessToken, account };
  } catch (error) {
    console.error("Couldn't renew a GitHub token", (error as Error).message);
    await markExpired(organizationId, personId);
    return null;
  }
}

async function markExpired(organizationId: string, personId: string): Promise<void> {
  await getDb().query(
    "update personal_connections set status = 'expired', updated_at = now() where organization_id = $1 and person_id = $2 and provider = 'github'",
    [organizationId, personId],
  );
}

/** Forgets the person's GitHub here, and asks GitHub to revoke what they granted Mach1. */
export async function disconnectGitHub(organizationId: string, personId: string): Promise<void> {
  const row = await readRow(organizationId, personId);
  if (!row) return;
  await getDb().query("delete from personal_connections where organization_id = $1 and person_id = $2 and provider = 'github'", [
    organizationId,
    personId,
  ]);
  try {
    const { accessToken } = unseal<Tokens>(row.secrets);
    const id = process.env.GITHUB_APP_CLIENT_ID!;
    await fetch(`${API}/applications/${id}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${Buffer.from(`${id}:${process.env.GITHUB_APP_CLIENT_SECRET}`).toString("base64")}`,
        "User-Agent": "Mach1",
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("Couldn't revoke a GitHub grant", (error as Error).message);
  }
}

/** Every person's GitHub tokens in this company, so anything read back from a sandbox can be scrubbed of them. */
export async function githubSecrets(organizationId: string): Promise<string[]> {
  const rows = await getDb().query<{ secrets: Uint8Array }>(
    "select secrets from personal_connections where organization_id = $1 and provider = 'github'",
    [organizationId],
  );
  return rows.flatMap((r) => {
    try {
      const t = unseal<Tokens>(r.secrets);
      return [t.accessToken, t.refreshToken].filter((v): v is string => Boolean(v));
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Using it

/** The hosts a sandbox's requests to GitHub go to, with how each is signed. */
export function githubSigning(token: string): Record<string, Record<string, string>> {
  // git over HTTPS takes the token as a password; the API takes it as a bearer token.
  const basic = { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
  const bearer = { Authorization: `Bearer ${token}` };
  return { "github.com": basic, "api.github.com": bearer, "uploads.github.com": bearer };
}

const MAX_BODY = 20_000;

/** One call to GitHub's REST API as the person: the status and the (shortened) response. */
export async function callGitHub(
  token: string,
  input: { method: string; path: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  if (!input.path.startsWith("/") || input.path.startsWith("//")) throw new GitHubError("Give an API path like /repos/owner/name/pulls.");
  const response = await fetch(`${API}${input.path}`, {
    method: input.method,
    headers: { ...apiHeaders(token), ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…(cut at ${MAX_BODY} characters)` : text };
}
