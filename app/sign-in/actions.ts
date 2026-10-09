"use server";

import { saveSession } from "@workos-inc/authkit-nextjs";
import { cookies, headers } from "next/headers";

import {
  safeReturnTo,
  sealPending,
  SIGN_IN_COOKIE,
  startWithEmail,
  unsealPending,
  withCode,
  withCompany,
  withEmailVerification,
  type Outcome,
  pendingInvitation,
  type Pending,
} from "@/lib/sign-in";

// Each step of signing in on Mach1's page. A step answers with the next one to
// show, somewhere to go (signed in, or on to a provider), or what went wrong.

export type Step =
  | { step: "code"; email: string }
  | { step: "verify"; email: string }
  | { step: "company"; companies: { id: string; name: string }[] }
  | { go: string }
  | { error: string };

type Context = { returnTo?: string; invitationToken?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function remember(pending: Pending): Promise<void> {
  const secure = (await origin()).startsWith("https:");
  (await cookies()).set(SIGN_IN_COOKIE, sealPending(pending), { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 15 * 60 });
}

async function remembered(): Promise<Pending> {
  return unsealPending((await cookies()).get(SIGN_IN_COOKIE)?.value) ?? {};
}

/** Where an attempt got to, as the page's next step; signed in, the session is saved. */
async function settle(outcome: Outcome, pending: Pending): Promise<Step> {
  const returnTo = safeReturnTo(pending.returnTo);
  switch (outcome.kind) {
    case "signed-in":
      await saveSession(outcome.auth, `${await origin()}/callback`);
      (await cookies()).delete(SIGN_IN_COOKIE);
      return { go: returnTo };
    case "choose-company":
      await remember({ ...pending, token: outcome.token, companies: outcome.companies });
      return { step: "company", companies: outcome.companies };
    case "verify-email":
      await remember({ ...pending, token: outcome.token });
      return { step: "verify", email: pending.email ?? "" };
    case "sso":
      return { go: link("/sign-in/sso", { connection: outcome.connectionId, email: pending.email, returnTo, invitation_token: pending.invitationToken }) };
    case "hosted":
      return { go: link("/sign-in/hosted", { email: pending.email, returnTo }) };
    case "error":
      return { error: outcome.message };
  }
}

function link(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return query.size ? `${path}?${query}` : path;
}

export async function emailStep(input: Context & { email: string }): Promise<Step> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return { error: "Enter your email address." };
  const invitationToken = input.invitationToken || (await pendingInvitation(email))?.token;
  const pending: Pending = { email, returnTo: input.returnTo, invitationToken };
  const h = await headers();
  const next = await startWithEmail(email, {
    invitationToken: pending.invitationToken,
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  await remember(pending);
  if (next.next === "sso") return settle({ kind: "sso", connectionId: next.connectionId }, pending);
  if (next.next === "error") return { error: next.message };
  return { step: "code", email };
}

export async function codeStep(input: { code: string }): Promise<Step> {
  const pending = await remembered();
  if (!pending.email) return { error: "That took too long. Start again." };
  return settle(await withCode(pending.email, input.code.replace(/\s/g, ""), pending.invitationToken), pending);
}

export async function verifyStep(input: { code: string }): Promise<Step> {
  const pending = await remembered();
  if (!pending.token) return { error: "That took too long. Start again." };
  return settle(await withEmailVerification(pending.token, input.code.replace(/\s/g, "")), { ...pending, token: undefined });
}

export async function companyStep(input: { organizationId: string }): Promise<Step> {
  const pending = await remembered();
  if (!pending.token || !pending.companies?.some((c) => c.id === input.organizationId)) return { error: "That took too long. Start again." };
  return settle(await withCompany(pending.token, input.organizationId), { ...pending, token: undefined, companies: undefined });
}

/** Sends a new code to the email in progress. */
export async function resendCode(): Promise<Step> {
  const pending = await remembered();
  if (!pending.email) return { error: "That took too long. Start again." };
  return emailStep({ email: pending.email, returnTo: pending.returnTo, invitationToken: pending.invitationToken });
}
