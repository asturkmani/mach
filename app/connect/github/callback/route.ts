import { NextResponse, type NextRequest } from "next/server";

import {
  exchangeGitHubCode,
  GITHUB_STATE_COOKIE,
  githubAccount,
  githubInstallUrl,
  githubRedirectUri,
  saveGitHubConnection,
} from "@/lib/github";
import { requireAppContext } from "@/lib/session";

// GitHub sends people back here after they let Mach1 act for them, or after
// they install the app (choosing repositories). The connection belongs to
// whoever is signed in, checked against the state this browser was given.

export async function GET(request: NextRequest) {
  const { organization, person } = await requireAppContext();
  const query = request.nextUrl.searchParams;
  let saved: { state?: string; returnTo?: string } = {};
  try {
    saved = JSON.parse(request.cookies.get(GITHUB_STATE_COOKIE)?.value ?? "{}");
  } catch {}
  const returnTo = saved.returnTo ?? "/settings/account";
  const back = (outcome: string) => {
    const response = NextResponse.redirect(new URL(`${returnTo.split("?")[0]}?github=${outcome}`, request.url));
    response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: "/connect/github" });
    return response;
  };

  // Back from installing the app (choosing repositories), not from a request of ours: ask again, which is instant now.
  if (!query.get("state") && (query.get("installation_id") || query.get("setup_action"))) {
    return NextResponse.redirect(new URL(`/connect/github?returnTo=${encodeURIComponent(returnTo)}`, request.url));
  }
  if (query.get("error")) return back("cancelled");
  const code = query.get("code");
  if (!code || !saved.state || query.get("state") !== saved.state) return back("expired");

  try {
    const tokens = await exchangeGitHubCode(code, githubRedirectUri(request.url));
    const account = await githubAccount(tokens.accessToken);
    await saveGitHubConnection(organization.id, person.id, tokens, account);
    // Connected, but no repositories chosen yet: on to choosing them.
    const installs = await fetch("https://api.github.com/user/installations", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokens.accessToken}`, "User-Agent": "Mach1" },
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ total_count: number }>) : null))
      .catch(() => null);
    const install = githubInstallUrl();
    if (installs && installs.total_count === 0 && install) {
      const response = NextResponse.redirect(install);
      response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: "/connect/github" });
      return response;
    }
    return back("connected");
  } catch (error) {
    console.error("Connecting GitHub failed", (error as Error).message);
    return back("failed");
  }
}
