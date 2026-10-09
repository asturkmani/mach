import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextRequest } from "next/server";

import { PROVIDERS, providerSignIn, safeReturnTo, sealPending, SIGN_IN_COOKIE, type Provider } from "@/lib/sign-in";

// Leaving Mach's sign-in page for somewhere that signs people in: Google or
// Microsoft (/sign-in/google), the company's single sign-on (/sign-in/sso), or
// WorkOS's own page for what Mach's doesn't do (/sign-in/hosted). The first
// three come back to /callback, which finishes them.

export async function GET(request: NextRequest, { params }: RouteContext<"/sign-in/[via]">) {
  const { via } = await params;
  const query = request.nextUrl.searchParams;
  const returnTo = safeReturnTo(query.get("returnTo"));
  const email = query.get("email") ?? undefined;
  const invitationToken = query.get("invitation_token") ?? undefined;

  if (via === "hosted") return NextResponse.redirect(await getSignInUrl({ loginHint: email, returnTo }));

  const connectionId = query.get("connection");
  const target = via === "sso" && connectionId ? { connectionId } : via in PROVIDERS ? { provider: via as Provider } : null;
  if (!target) return NextResponse.redirect(new URL("/sign-in", request.url));

  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? new URL("/callback", request.url).href;
  const { url, state, codeVerifier } = await providerSignIn(target, { redirectUri, loginHint: email, invitationToken });
  const response = NextResponse.redirect(url);
  response.cookies.set(SIGN_IN_COOKIE, sealPending({ state, codeVerifier, returnTo, invitationToken, email }), {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
  return response;
}
