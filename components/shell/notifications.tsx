"use client";

import { useInstall, usePush } from "./device";
import { useNotificationPermission } from "./inbox-notifier";

// Turning notifications on, wherever it's offered (the left menu, the phone's
// menu, account settings). With push set up, a device subscribes and gets
// notifications while Mach is closed; without it, the browser notifies only
// while Mach is open in a tab.

const IOS_STEPS = "On an iPhone, add Mach to your Home Screen first: tap Share, then Add to Home Screen. Open it from there and turn notifications on.";

export function useNotifications() {
  const push = usePush();
  const plain = useNotificationPermission();
  const { state: install } = useInstall();

  if (push.state !== "unsupported") {
    const on = push.state === "on";
    return {
      available: true,
      on,
      label: on ? "Notifications on" : push.state === "needs-install" ? "Get notifications" : "Turn on notifications",
      /** Turns them on or off on this device; says what happened. */
      toggle: async (): Promise<string> => {
        if (on) {
          await push.turnOff();
          return "Notifications are off on this device.";
        }
        if (push.state === "needs-install") return IOS_STEPS;
        if (push.state === "denied") return "Notifications are blocked for Mach. Allow them in your settings, then try again.";
        const problem = await push.turnOn();
        return problem ?? "You'll get a notification when something needs you, even with Mach closed.";
      },
    };
  }
  if (plain.state === "unsupported") {
    // An iPhone in Safari without push set up: still nothing to offer until it's installed.
    return { available: install === "ios", on: false, label: "Get notifications", toggle: async () => IOS_STEPS };
  }
  const on = plain.state === "granted";
  return {
    available: true,
    on,
    label: on ? "Notifications on" : "Turn on notifications",
    toggle: async (): Promise<string> => {
      if (on) return "Notifications are on. Turn them off in your browser's site settings.";
      const result = await plain.request();
      return result === "granted" ? "You'll get a notification when something needs you." : "Notifications are blocked in your browser's settings.";
    },
  };
}
