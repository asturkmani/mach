# Signing in

Mach1 has its own sign-in page at `/sign-in`, on Mach1's domain. WorkOS still keeps the accounts, companies, invitations and single sign-on; Mach1 shows the screens and calls WorkOS's API behind them. The only time someone leaves Mach1 is to sign in with Google, Microsoft or their company's identity provider, and they come straight back.

## What someone sees

1. **Continue with Google** or **Continue with Microsoft**. These buttons only appear for providers turned on in WorkOS.
2. **Or a work email**:
   - If their company has **single sign-on** (an active WorkOS connection for the email's domain), they go straight to it. Personal addresses like gmail.com never look for one.
   - Otherwise they get a **6-digit code by email** (WorkOS Magic Auth). The code box takes a pasted or auto-filled code and submits itself.
   - If Magic Auth is off in WorkOS, they get a **password** step instead. A new email gets "Create your account" (name and password), then a code by email to confirm the address. "Forgot your password?" goes to WorkOS's reset.
3. **Which company?** Someone in more than one company picks one.
4. **Back where they were going.** Signed out, any page sends them to `/sign-in?returnTo=…` and back afterwards. A new person with no company goes to `/welcome`, as before.

New and returning people take the same steps: the first sign-in creates the account. Signed-in people who open `/sign-in` go straight in. Signing out lands back on `/sign-in`.

**Other ways to sign in** (at the bottom of the page) opens WorkOS's own page, which handles anything Mach1's doesn't: multi-factor authentication, password resets, and a Radar challenge. Mach1 sends people there automatically when WorkOS asks for one of these.

## Finding your company

A company's **email domain** is the work domain of whoever creates it, once their email is verified. Every way of signing in verifies it: a code, a password confirmed with a code, Google, Microsoft, or single sign-on. Personal addresses (gmail.com, outlook.com…) never claim one.

When someone signs in for the first time with that domain, `/welcome` shows the company instead of offering to create a duplicate:

- **Ask to join** (the default) puts a request, a task of kind `join_request`, in every admin's inbox, with a push notification: *Let them in* or *Decline*. They join as a member. Their page checks every 15 seconds and shows the company to open once an admin says yes. After a decline they can ask again.
- **Join** straight away, when an admin has turned on **Colleagues join on their own** (Settings → General). This is off by default: contractors, or people who've left but whose mailbox still works, would otherwise get in.

**Roles** live in WorkOS: `admin` or `member`. Whoever creates a company is its first admin. Admins make others admins (or members again) on the Team page. A company always keeps at least one admin, and nobody changes their own role. Code: `lib/members.ts`.

## How it works

| Part | Where |
|---|---|
| The page and its steps | `app/sign-in/page.tsx`, `sign-in-form.tsx`, `actions.ts` |
| Leaving for Google, Microsoft, single sign-on or WorkOS's page | `app/sign-in/[via]/route.ts` |
| Coming back from them | `app/callback/route.ts` |
| Talking to WorkOS | `lib/sign-in.ts` |
| Who must be signed in | `proxy.ts` |

- **Sessions** are WorkOS AuthKit's, saved with its `saveSession`, so everything else (`withAuth`, refreshing, switching company, signing out) is unchanged.
- **Provider sign-ins** use PKCE and a random state starting `mach.`. They come back to the same `/callback` that is already registered in WorkOS, so there's no new redirect URI to add. Anything without that state (an invitation accepted on WorkOS's page, say) goes to AuthKit's own handler, as before.
- **Between steps**, the email, the return path, an invitation token and WorkOS's pending token live in an HMAC-signed, httpOnly cookie (`mach-sign-in`, signed with `WORKOS_COOKIE_PASSWORD`, good for 15 minutes). They never reach the browser's scripts.
- **The return path** can only be a path inside Mach1 (`safeReturnTo`), so a sign-in link can't send someone elsewhere afterwards.
- **Which providers to show** is checked against WorkOS every 10 minutes: WorkOS answers a provider that isn't set up with a 404. Set `SIGN_IN_PROVIDERS=google,microsoft` (or empty) to fix the list instead.
- **Invitations**: a link with `?invitation_token=…` on `/sign-in` carries the token through every way of signing in, and signing in accepts the invitation. WorkOS's invitation emails link to its own page unless you change the invitation URL in the dashboard to `https://<your domain>/sign-in`. Either works.

## Setting up WorkOS

In each environment (Staging, Production):

1. **Authentication → Magic Auth: on.** This gives the email code.
2. **Authentication → Google OAuth and Microsoft OAuth: on.** Production needs your own credentials:
   - **Google:** a Google Cloud OAuth client.
   - **Microsoft:** an Azure app registration, set to "accounts in any organizational directory and personal accounts" so work and personal Microsoft accounts both work.
   - In both, the redirect URI is the one WorkOS shows.
3. **Redirects:** `…/callback` as the redirect URI (already there), `…/sign-in` as the sign-in endpoint, and the app's root as the sign-out redirect.
4. **Single sign-on, per client:** in their organization in WorkOS, add their domain and an SSO connection (Okta, Entra ID, Google Workspace…). Their work emails then go straight to it from Mach1's page.
