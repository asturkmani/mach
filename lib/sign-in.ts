import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getWorkOS } from "@workos-inc/authkit-nextjs";
import type { AuthenticationResponse } from "@workos-inc/node";

import { companyDomainFromEmail } from "@/lib/website";

// Signing in on Mach's own page, through WorkOS's API: a code by email (Magic
// Auth) or a password, Google or Microsoft, and the company's single sign-on
// for a work domain that has one. WorkOS keeps the accounts; Mach shows the
// screens. Anything unusual (multi-factor, a password reset) finishes on
// WorkOS's hosted page, which can do everything.

export type Provider = "google" | "microsoft";

export const PROVIDERS: Record<Provider, { workos: string; label: string }> = {
  google: { workos: "GoogleOAuth", label: "Google" },
  microsoft: { workos: "MicrosoftOAuth", label: "Microsoft" },
};

/** Where an attempt to sign in got to. */
export type Outcome =
  | { kind: "signed-in"; auth: AuthenticationResponse }
  /** They belong to more than one company: which one? */
  | { kind: "choose-company"; token: string; companies: { id: string; name: string }[] }
  /** WorkOS emailed a code to confirm the address. */
  | { kind: "verify-email"; token: string }
  /** Their company signs in with its own identity provider. */
  | { kind: "sso"; connectionId: string }
  /** Something only WorkOS's own page handles (multi-factor and the like). */
  | { kind: "hosted" }
  | { kind: "error"; message: string };

const clientId = () => process.env.WORKOS_CLIENT_ID!;

type WorkOSError = { name?: string; code?: string; status?: number; message?: string; rawData?: Record<string, unknown> };

/** The machine-readable reason in a WorkOS error, wherever it put it. */
export function errorCode(error: unknown): string {
  const e = (error ?? {}) as WorkOSError;
  return String(e.rawData?.code ?? e.rawData?.error ?? e.code ?? "");
}

/** Runs one way of authenticating and says where it got to. */
export async function attempt(authenticate: () => Promise<AuthenticationResponse>): Promise<Outcome> {
  try {
    return { kind: "signed-in", auth: await authenticate() };
  } catch (error) {
    const code = errorCode(error);
    const data = ((error as WorkOSError).rawData ?? {}) as {
      pending_authentication_token?: string;
      organizations?: { id: string; name: string }[];
      connection_ids?: string[];
    };
    const token = data.pending_authentication_token;
    if (code === "organization_selection_required" && token) {
      return { kind: "choose-company", token, companies: data.organizations ?? [] };
    }
    if (code === "email_verification_required" && token) return { kind: "verify-email", token };
    if (code === "sso_required" && data.connection_ids?.[0]) return { kind: "sso", connectionId: data.connection_ids[0] };
    if (["mfa_enrollment", "mfa_challenge", "mfa_verification", "radar_email_challenge", "radar_sms_challenge"].includes(code)) {
      return { kind: "hosted" };
    }
    return { kind: "error", message: friendly(code, error) };
  }
}

function friendly(code: string, error: unknown): string {
  if (code === "invalid_one_time_code" || code === "invalid_code" || code === "one_time_code_expired") {
    return "That code didn't work. Check it, or send a new one.";
  }
  if (code === "invalid_credentials") return "That email and password don't match.";
  if (code === "password_strength_error" || code === "password_too_weak") {
    return "Choose a stronger password: at least 10 characters, not a common one.";
  }
  if (code === "user_creation_error" || code === "email_not_available") return "There's already an account for that email. Sign in instead.";
  if (code === "authentication_method_not_allowed") return "That way of signing in isn't turned on for Mach.";
  console.error("Sign-in failed", code, (error as WorkOSError)?.message);
  return "Something went wrong signing in. Try again.";
}

/** The active single sign-on connection for this work email's domain, if its company has one. */
export async function ssoConnectionFor(email: string): Promise<string | null> {
  const domain = companyDomainFromEmail(email);
  if (!domain) return null;
  try {
    const connections = await getWorkOS().sso.listConnections({ domain });
    return connections.data.find((c) => c.state === "active")?.id ?? null;
  } catch (error) {
    console.error("Looking up single sign-on failed", errorCode(error));
    return null;
  }
}

/**
 * The first step for an email: their company's single sign-on, else a code by
 * email, else (codes not turned on in WorkOS) a password, to create one if
 * they don't have an account yet.
 */
export async function startWithEmail(
  email: string,
  options: { invitationToken?: string; ipAddress?: string; userAgent?: string } = {},
): Promise<{ next: "sso"; connectionId: string } | { next: "code" } | { next: "password"; newUser: boolean } | { next: "error"; message: string }> {
  const connectionId = await ssoConnectionFor(email);
  if (connectionId) return { next: "sso", connectionId };
  try {
    await getWorkOS().userManagement.createMagicAuth({ email, ...options });
    return { next: "code" };
  } catch (error) {
    if (errorCode(error) !== "authentication_method_not_allowed") return { next: "error", message: friendly(errorCode(error), error) };
  }
  const users = await getWorkOS().userManagement.listUsers({ email });
  return { next: "password", newUser: users.data.length === 0 };
}

export const withCode = (email: string, code: string, invitationToken?: string) =>
  attempt(() => getWorkOS().userManagement.authenticateWithMagicAuth({ clientId: clientId(), email, code, invitationToken }));

export const withPassword = (email: string, password: string, invitationToken?: string) =>
  attempt(() => getWorkOS().userManagement.authenticateWithPassword({ clientId: clientId(), email, password, invitationToken }));

/** A new account with a password; WorkOS then emails a code to confirm the address. */
export async function createAccount(email: string, password: string, name: string, invitationToken?: string): Promise<Outcome> {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  try {
    await getWorkOS().userManagement.createUser({ email, password, firstName: firstName || undefined, lastName: rest.join(" ") || undefined });
  } catch (error) {
    return { kind: "error", message: friendly(errorCode(error), error) };
  }
  return withPassword(email, password, invitationToken);
}

export const withEmailVerification = (pendingAuthenticationToken: string, code: string) =>
  attempt(() => getWorkOS().userManagement.authenticateWithEmailVerification({ clientId: clientId(), pendingAuthenticationToken, code }));

export const withCompany = (pendingAuthenticationToken: string, organizationId: string) =>
  attempt(() => getWorkOS().userManagement.authenticateWithOrganizationSelection({ clientId: clientId(), pendingAuthenticationToken, organizationId }));

/** The state Mach's own provider sign-ins carry, so /callback can tell them from WorkOS-page ones. */
export const OAUTH_STATE_PREFIX = "mach.";

/** Where to send someone to sign in with Google, Microsoft or their company's single sign-on, and what to remember meanwhile. */
export async function providerSignIn(
  via: { provider: Provider } | { connectionId: string },
  options: { redirectUri: string; loginHint?: string; invitationToken?: string },
): Promise<{ url: string; state: string; codeVerifier: string }> {
  const workos = getWorkOS();
  const pkce = await workos.pkce.generate();
  const state = `${OAUTH_STATE_PREFIX}${randomBytes(16).toString("base64url")}`;
  const url = workos.userManagement.getAuthorizationUrl({
    clientId: clientId(),
    redirectUri: options.redirectUri,
    ...("provider" in via ? { provider: PROVIDERS[via.provider].workos } : { connectionId: via.connectionId }),
    loginHint: options.loginHint,
    state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  });
  return { url, state, codeVerifier: pkce.codeVerifier };
}

export const withProviderCode = (code: string, codeVerifier: string, invitationToken?: string) =>
  attempt(() => getWorkOS().userManagement.authenticateWithCode({ clientId: clientId(), code, codeVerifier, invitationToken }));

/**
 * Which of Google and Microsoft are turned on in this WorkOS environment, to
 * show only buttons that work. WorkOS answers an authorization for a provider
 * that isn't set up with a 404. Checked every 10 minutes.
 */
let providerCheck: { at: number; providers: Provider[] } | null = null;
export async function enabledProviders(redirectUri: string): Promise<Provider[]> {
  if (process.env.SIGN_IN_PROVIDERS !== undefined) {
    return process.env.SIGN_IN_PROVIDERS.split(",").map((p) => p.trim()).filter((p): p is Provider => p in PROVIDERS);
  }
  if (providerCheck && Date.now() - providerCheck.at < 10 * 60_000) return providerCheck.providers;
  const results = await Promise.all(
    (Object.keys(PROVIDERS) as Provider[]).map(async (provider) => {
      const url = getWorkOS().userManagement.getAuthorizationUrl({ clientId: clientId(), redirectUri, provider: PROVIDERS[provider].workos, state: "check" });
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) }).catch(() => null);
      return response && response.status >= 300 && response.status < 400 ? provider : null;
    }),
  );
  providerCheck = { at: Date.now(), providers: results.filter((p): p is Provider => p !== null) };
  return providerCheck.providers;
}

// ---- What a sign-in remembers between steps, in a signed cookie ----------

export const SIGN_IN_COOKIE = "mach-sign-in";

export type Pending = {
  email?: string;
  returnTo?: string;
  invitationToken?: string;
  /** WorkOS's token for the step in progress (confirming the email, choosing a company). */
  token?: string;
  companies?: { id: string; name: string }[];
  /** A provider sign-in in progress. */
  state?: string;
  codeVerifier?: string;
};

function sign(value: string): string {
  return createHmac("sha256", process.env.WORKOS_COOKIE_PASSWORD!).update(value).digest("base64url");
}

export function sealPending(pending: Pending): string {
  const body = Buffer.from(JSON.stringify({ ...pending, at: Date.now() })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** What the cookie remembers, if it's ours, intact and less than 15 minutes old. */
export function unsealPending(cookie: string | undefined): Pending | null {
  if (!cookie) return null;
  const [body, signature] = cookie.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { at, ...pending } = JSON.parse(Buffer.from(body, "base64url").toString()) as Pending & { at: number };
    return Date.now() - at < 15 * 60_000 ? pending : null;
  } catch {
    return null;
  }
}

/** Only a path inside Mach, so a sign-in link can't send someone elsewhere afterwards. */
export function safeReturnTo(value: string | null | undefined): string {
  return value && /^\/(?!\/)[^\s\\]*$/.test(value) && !value.startsWith("/sign-in") && !value.startsWith("/callback") ? value : "/";
}
