"use client";

import { signOutAction } from "@/app/(app)/actions";
import { SettingRow } from "@/components/setting-row";
import { useInstall } from "@/components/shell/device";
import { useNotifications } from "@/components/shell/notifications";
import { useShell, type Theme } from "@/components/shell/shell";

const THEMES: [Theme, string][] = [
  ["system", "Match system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** Your preferences in this browser, and signing out: the end of Settings → Account. */
export function AccountPreferences() {
  const { theme, setTheme, toast } = useShell();
  const notifications = useNotifications();
  const install = useInstall();

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
      {notifications.available && (
        <SettingRow
          title="Notifications"
          description={
            notifications.on
              ? "On for this device: you get a notification when something needs you."
              : "Get a notification on this device when a task needs your answer or review, or someone mentions you."
          }
          action={
            <button onClick={async () => toast(await notifications.toggle())} className="btn">
              {notifications.on ? "Turn off" : "Turn on"}
            </button>
          }
        />
      )}
      {(install.state === "prompt" || install.state === "ios") && (
        <SettingRow
          title="Mach1 app"
          description={
            install.state === "ios"
              ? "Add Mach1 to your Home Screen: tap Share in Safari, then Add to Home Screen. It opens full screen, with notifications."
              : "Install Mach1 on this device: it opens in its own window, with its icon in your dock or home screen."
          }
          action={
            install.state === "prompt" ? (
              <button onClick={async () => (await install.install()) && toast("Mach1 is installed.")} className="btn">
                Install
              </button>
            ) : undefined
          }
        />
      )}
      <SettingRow
        title="Sign out"
        description="Of Mach1 in this browser."
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
