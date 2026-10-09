import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { GITHUB_STATE_COOKIE, githubAuthorizeUrl, githubConfigured, githubRedirectUri } from "@/lib/github";
import { requireAppContext } from "@/lib/session";
import { safeReturnTo } from "@/lib/sign-in";

// Connect GitHub: sends the signed-in person to GitHub to let Mach1 act for
// them (docs/github.md). /connect/github/callback finishes it. The link works
// from anywhere, a WhatsApp message included: signed out, it signs in first.

export async function GET(request: NextRequest) {
  await requireAppContext();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo") ?? "/settings/account");
  if (!githubConfigured()) return NextResponse.redirect(new URL(`${returnTo.split("?")[0]}?github=unavailable`, request.url));
  const state = randomBytes(16).toString("base64url");
  const response = NextResponse.redirect(githubAuthorizeUrl(state, githubRedirectUri(request.url)));
  response.cookies.set(GITHUB_STATE_COOKIE, JSON.stringify({ state, returnTo }), {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/connect/github",
    maxAge: 15 * 60,
  });
  return response;
}
