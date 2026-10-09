import { handleAuth, saveSession } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextRequest } from "next/server";

import { OAUTH_STATE_PREFIX, safeReturnTo, sealPending, SIGN_IN_COOKIE, unsealPending, withProviderCode } from "@/lib/sign-in";

// WorkOS redirects here after sign-in (NEXT_PUBLIC_WORKOS_REDIRECT_URI). Google,
// Microsoft and single sign-on started from Mach1's own page carry its state
// ("mach.…") and are finished here; anything started on WorkOS's page (an
// invitation link, say) goes to AuthKit's handler as before.

const authkitCallback = handleAuth({ returnPathname: "/" });

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state") ?? "";
  if (!state.startsWith(OAUTH_STATE_PREFIX)) return authkitCallback(request);

  const pending = unsealPending(request.cookies.get(SIGN_IN_COOKIE)?.value);
  const code = request.nextUrl.searchParams.get("code");
  const back = (problem: string) => NextResponse.redirect(new URL(`/sign-in?error=${problem}`, request.url));
  if (request.nextUrl.searchParams.get("error")) return back("cancelled");
  if (!pending?.codeVerifier || pending.state !== state || !code) return back("expired");

  const outcome = await withProviderCode(code, pending.codeVerifier, pending.invitationToken);
  const cookie = { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax" as const, path: "/", maxAge: 15 * 60 };
  const rest = { returnTo: pending.returnTo, invitationToken: pending.invitationToken, email: outcome.kind === "signed-in" ? undefined : pending.email };

  switch (outcome.kind) {
    case "signed-in": {
      await saveSession(outcome.auth, request);
      const response = NextResponse.redirect(new URL(safeReturnTo(pending.returnTo), request.url));
      response.cookies.delete(SIGN_IN_COOKIE);
      return response;
    }
    case "choose-company":
    case "verify-email": {
      const step = outcome.kind === "choose-company" ? "company" : "verify";
      const response = NextResponse.redirect(new URL(`/sign-in?step=${step}`, request.url));
      const companies = outcome.kind === "choose-company" ? outcome.companies : undefined;
      response.cookies.set(SIGN_IN_COOKIE, sealPending({ ...rest, token: outcome.token, companies }), cookie);
      return response;
    }
    case "sso":
      return NextResponse.redirect(new URL(`/sign-in/sso?connection=${encodeURIComponent(outcome.connectionId)}`, request.url));
    case "hosted":
      return NextResponse.redirect(new URL("/sign-in/hosted", request.url));
    case "error":
      return back("failed");
  }
}
