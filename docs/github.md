# Each person's own GitHub

People connect their own GitHub account to Mach1, and agents work in their
repositories as them: clone, branch, commit, push and open a pull request. That
includes asking from WhatsApp ("fix the typo on the pricing page") and hearing
back there with the pull request link.

A person's GitHub is theirs alone. It's used only for work they ask for:

- **The Chief of Staff** uses it while it talks with them (`github_api`: their
  pull requests, a repository's recent commits). Never while it talks with
  someone else.
- **A task run** uses the GitHub of the person it's for: whoever wrote the
  message it's answering, else the last person to comment, else whoever asked
  for the task (`workingForId` in `lib/agents/run-steps.ts`). If they haven't
  connected theirs, the agent asks them to, with the link. It never falls back
  to anyone else's.

This replaces putting a GitHub token in a company integration, which every
agent could use. Delete any such integration (Settings → Integrations) and
revoke its token on GitHub.

## How it works

| | |
| --- | --- |
| Connecting | Settings → Account → Your accounts → **Connect GitHub**, or the link `/connect/github` (it works from a WhatsApp message: signed out, it signs in first). GitHub asks them to let Mach1 act for them; if Mach1 isn't installed on any of their accounts yet, they're sent on to choose which repositories it may use. |
| Tokens | User access tokens of Mach1's GitHub App: they act as the person, only in repositories where the app is installed and the person has access. They last 8 hours and renew themselves (the refresh token lasts 6 months; after that, or if they revoke it, they reconnect). Sealed with `MACH_SECRETS_KEY` in `personal_connections`. **Disconnect** deletes them and revokes the grant on GitHub. |
| In a sandbox | Only a sandbox where everything running is that person's: a task's, which runs one run at a time, or their own (the Chief of Staff's while it talks with them, one turn at a time). For the run, requests to `github.com` (git), `api.github.com` and `uploads.github.com` get the person's token added by the sandbox's network proxy, so plain `git clone https://github.com/owner/repo.git` and `git push` work and the token never enters the sandbox. Commits are signed with their name and GitHub's private address for them. When the run ends, the policy goes back to allow-all. |
| The Developer agent | A built-in agent made the first time someone asks for a code change (`start_coding`). It follows the `coding-in-github` skill: branch, change, run the repository's checks, push, open a pull request, report back with the link. It never pushes to the default branch, and merges only when the person says so. |
| WhatsApp | A code change asked for on WhatsApp is marked `reply_by_whatsapp`: when it's ready for review or needs an answer, the person who asked gets the agent's latest word there, with the link, and it's added to their Chief of Staff chat so a reply like "merge it" reaches the task. (WhatsApp allows this within 24 hours of their last message; after that, the push notification and Home still show it.) |

## Setting up the GitHub App (once, by Mach1's admin)

1. On GitHub, under the organization that should own it: **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **Name:** Mach1. **Homepage URL:** https://trymach1.app.
3. **Callback URL:** `https://trymach1.app/connect/github/callback`. Tick **Expire user authorization tokens** and **Request user authorization (OAuth) during installation**.
4. **Webhook:** untick **Active** (Mach1 doesn't need events).
5. **Repository permissions:** Contents: Read and write · Pull requests: Read and write · Issues: Read and write · Workflows: Read and write (to change CI files) · Checks: Read-only · Commit statuses: Read-only · Actions: Read-only · Metadata: Read-only. No organization or account permissions.
6. **Where can this GitHub App be installed?** Any account, so clients can install it on their own organizations.
7. Create it, then **Generate a new client secret**.
8. In Vercel (Production), set:
   - `GITHUB_APP_CLIENT_ID`: the app's Client ID (starts with `Iv`)
   - `GITHUB_APP_CLIENT_SECRET`: the secret from step 7
   - `GITHUB_APP_SLUG`: the app's name in its URL (`github.com/apps/<slug>`), for the "Choose repositories" link
   - optionally `GITHUB_APP_REDIRECT_URI`, if the callback URL isn't `<this site>/connect/github/callback`

A company that keeps its code in a GitHub organization installs the app there once (an owner approves it); after that, each person only connects their own account.

## Where the code is

| Path | What it is |
| --- | --- |
| `lib/github.ts` | Connections, token renewal, revoking, signing headers, `callGitHub` |
| `app/connect/github/` | Connect and callback routes |
| `components/github-connection.tsx` | The row in Settings → Account |
| `lib/agents/run-steps.ts` | `workingForId`: who a run is for |
| `lib/agents/sandbox-steps.ts` | Attaches the run's person's GitHub to the task's sandbox |
| `lib/agents/github-steps.ts`, `githubTools` in `lib/agents/toolkit.ts` | `github_api` |
| `lib/agents/chief-of-staff.ts` | `start_coding` and what the Chief of Staff knows about your GitHub |
| `lib/agents/store.ts`, `lib/agents/skills.ts` | The Developer agent and its `coding-in-github` playbook |
| `lib/channels/task-replies.ts` | Reporting back on WhatsApp |
