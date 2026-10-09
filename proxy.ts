import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextRequest } from "next/server";

// Every page and API route requires a signed-in user, except signing in itself
// (Mach's /sign-in page and the routes it uses, and /callback), the cron tick,
// which checks Vercel Cron's secret instead, and the WhatsApp and email
// webhooks, which check Twilio's and AgentMail's signatures. Signed out, a page
// goes to /sign-in (and back afterwards); an API call gets a 401. The
// installable app's own files (its manifest, service worker, icons and offline
// screen) load before sign-in.

const PUBLIC = ["/sign-in", "/callback", "/api/cron/tick", "/api/whatsapp", "/api/email"];

const isPublic = (pathname: string) => PUBLIC.some((path) => pathname === path || pathname.startsWith(`${path}/`));

export default async function proxy(request: NextRequest) {
  const { session, headers } = await authkit(request);
  const { pathname, search } = request.nextUrl;

  if (session.user) {
    // Already signed in: the sign-in page has nothing to do.
    if (pathname === "/sign-in") {
      const returnTo = request.nextUrl.searchParams.get("returnTo");
      return handleAuthkitHeaders(request, headers, { redirect: returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/" });
    }
    return handleAuthkitHeaders(request, headers);
  }

  if (isPublic(pathname)) return handleAuthkitHeaders(request, headers);
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const signIn = new URL("/sign-in", request.url);
  if (pathname !== "/") signIn.searchParams.set("returnTo", `${pathname}${search}`);
  return handleAuthkitHeaders(request, headers, { redirect: signIn });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|sw.js|offline.html|icons/|brand/|.well-known/workflow/).*)",
  ],
};
