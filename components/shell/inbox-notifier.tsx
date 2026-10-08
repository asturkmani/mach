"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { arrivals, type InboxItem } from "@/lib/inbox-arrivals";

import { pushOn } from "./device";
import { useShell } from "./shell";

// Tells people when something lands in their inbox: a toast in Mach, a
// browser notification when Mach isn't the window they're in (once they've
// allowed it), and the count in the tab's title.

const STATUS_NOTE: Record<string, string> = { review: "is ready for review", waiting: "needs your answer" };

const permission = {
  read: (): NotificationPermission | "unsupported" =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  // Permission changes come from our own request (below) or the browser's settings; check again on focus.
  subscribe: (onChange: () => void) => {
    window.addEventListener("focus", onChange);
    window.addEventListener("mach-notification-permission", onChange);
    return () => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener("mach-notification-permission", onChange);
    };
  },
};

export function useNotificationPermission() {
  const state = useSyncExternalStore(permission.subscribe, permission.read, () => "unsupported" as const);
  const request = async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    const result = await Notification.requestPermission();
    window.dispatchEvent(new Event("mach-notification-permission"));
    return result;
  };
  return { state, request };
}

/** A system notification, through the service worker where there is one (Android only allows it that way). */
async function notify(what: string, item: InboxItem, open: (path: string) => void) {
  const title = `Mach · ${what}`;
  const options = { body: item.summary || item.title, tag: `task-${item.id}` };
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (registration) {
    return registration.showNotification(title, { ...options, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { url: `/tasks/${item.number}` } });
  }
  const note = new Notification(title, options);
  note.onclick = () => {
    window.focus();
    open(`/tasks/${item.number}`);
    note.close();
  };
}

export function InboxNotifier() {
  const { data, toast } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const seen = useRef<Map<string, InboxItem> | null>(null);

  useEffect(() => {
    const items = data.inbox;
    // The first render only records what's already there.
    if (seen.current) {
      for (const item of arrivals(seen.current, items).slice(0, 3)) {
        const what = `#${item.number} ${STATUS_NOTE[item.status] ?? "needs you"}`;
        const onTask = pathname === `/tasks/${item.number}`;
        if (!onTask) toast(`${what}: ${item.title}`, { href: `/tasks/${item.number}` });
        // A device with push on is notified by the server, open or not.
        if (!document.hasFocus() && permission.read() === "granted" && !pushOn()) void notify(what, item, router.push);
      }
    }
    seen.current = new Map(items.map((item) => [item.id, item]));
  }, [data.inbox, pathname, router, toast]);

  // "(2) Mach" in the tab while two things wait on you.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = data.inboxCount > 0 ? `(${data.inboxCount}) ${base}` : base;
  }, [data.inboxCount, pathname]);

  return null;
}
