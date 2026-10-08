"use client";

import { signOutAction } from "@/app/(app)/actions";
import { SettingRow } from "@/components/setting-row";
import { useNotificationPermission } from "@/components/shell/inbox-notifier";
import { useShell, type Theme } from "@/components/shell/shell";

const THEMES: [Theme, string][] = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** Your preferences in this browser, and signing out: the end of Settings → Account. */
export function AccountPreferences() {
  const { theme, setTheme, toast } = useShell();
  const notifications = useNotificationPermission();

  const turnOnNotifications = async () => {
    const result = await notifications.request();
    toast(
      result === "granted"
        ? "You'll get a notification when something needs you."
        : "Notifications are blocked. Allow them for this site in your browser's settings.",
    );
  };

  return (
    <>
      <SettingRow
        title="Theme"
        action={
          <div className="flex border border-line" role="radiogroup" aria-label="Theme">
            {THEMES.map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={`px-2.5 py-1 text-[13px] ${theme === value ? "bg-selected text-ink" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {notifications.state !== "unsupported" && (
        <SettingRow
          title="Notifications"
          description={
            notifications.state === "granted"
              ? "On in this browser. Turn them off in your browser's site settings."
              : "Get a notification in this browser when something needs you."
          }
          action={
            notifications.state === "granted" ? undefined : (
              <button onClick={turnOnNotifications} className="btn">
                Turn on
              </button>
            )
          }
        />
      )}
      <SettingRow
        title="Sign out"
        description="Of Mach in this browser."
        action={
          <form action={signOutAction}>
            <button type="submit" className="btn">
              Sign out
            </button>
          </form>
        }
      />
    </>
  );
}
