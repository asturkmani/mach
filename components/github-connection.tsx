"use client";

import { useTransition } from "react";

import { disconnectGitHubAction } from "@/app/(app)/settings/actions";
import { SettingRow } from "@/components/setting-row";

// Your GitHub in Settings → Account: connect it (GitHub asks you, and you
// choose which repositories Mach1 may use), see which account it is, choose
// more repositories, or disconnect it.

export function GitHubConnection({
  configured,
  account,
  installUrl,
  outcome,
}: {
  configured: boolean;
  account: { login: string; name: string; status: "connected" | "expired" } | null;
  installUrl: string | null;
  /** What just happened, from ?github= after GitHub sent you back. */
  outcome?: string;
}) {
  const [pending, start] = useTransition();
  const note =
    outcome === "connected"
      ? "Connected."
      : outcome === "cancelled"
        ? "You didn't connect it."
        : outcome === "failed" || outcome === "expired"
          ? "That didn't work. Try again."
          : null;

  if (!configured) {
    return <SettingRow title="GitHub" description="Not set up for Mach1 yet: it needs a GitHub App (see docs/github.md)." />;
  }
  if (!account) {
    return (
      <SettingRow
        title="GitHub"
        description={
          <>
            Connect your own GitHub so agents can work in your repositories as you: clone them, commit to a branch and open a pull
            request, including from WhatsApp. Only work you ask for uses it.
            {note && <span className="block text-warn">{note}</span>}
          </>
        }
        action={
          <a href="/connect/github" className="btn btn-primary">
            Connect GitHub
          </a>
        }
      />
    );
  }
  return (
    <SettingRow
      title="GitHub"
      description={
        <>
          {account.status === "expired" ? (
            <span className="text-warn">@{account.login} needs connecting again (GitHub stopped accepting it).</span>
          ) : (
            <>
              Connected as <span className="text-ink">@{account.login}</span>
              {account.name ? ` (${account.name})` : ""}. Agents use it only for work you ask for, and commits show as you.
            </>
          )}
          {note && account.status !== "expired" && <span className="block text-ok">{note}</span>}
        </>
      }
      action={
        <>
          {account.status === "expired" ? (
            <a href="/connect/github" className="btn btn-primary">
              Reconnect
            </a>
          ) : (
            installUrl && (
              <a href={installUrl} className="btn" target="_blank" rel="noreferrer">
                Choose repositories
              </a>
            )
          )}
          <button className="btn btn-ghost" disabled={pending} onClick={() => start(() => disconnectGitHubAction())}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </button>
        </>
      }
    />
  );
}
