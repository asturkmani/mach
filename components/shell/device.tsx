"use client";

import { WifiOff } from "lucide-react";
import { useOffline } from "next/offline";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { subscribePushAction, unsubscribePushAction } from "@/app/(app)/actions";

import { useShell } from "./shell";

// Mach1 as an app on this phone or computer: its service worker (public/sw.js),
// installing it, push notifications, the count on its icon, and a line when
// the connection drops.

// ---- Installing ----------------------------------------------------------

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/** Chrome and Edge offer installing once, early: kept here until someone asks. */
let deferred: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    installListeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installListeners.forEach((l) => l());
  });
}

/** Running as the installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true)
  );
}

/**
 * An iPhone lays its keyboard over the page without resizing it, scrolls the
 * page to show the field, and leaves it shifted after. While the keyboard is
 * up, the app is sized to what's visible (--keyboard-height, the
 * "keyboard-open" class on <html>), and the page never stays scrolled. iOS
 * reports the keyboard once, mid-animation, so it's measured again as it
 * settles.
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view || !isAppleMobile()) return;
    const root = document.documentElement;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sync = () => {
      if (view.scale > 1.01) return; // pinch-zoomed: leave it be
      const open = window.innerHeight - view.height > 120;
      root.classList.toggle("keyboard-open", open);
      if (open) root.style.setProperty("--keyboard-height", `${view.height}px`);
      else root.style.removeProperty("--keyboard-height");
      if (window.scrollY) window.scrollTo(0, 0);
    };
    const settle = () => {
      sync();
      for (const delay of [100, 300, 600, 1000]) timers.push(setTimeout(sync, delay));
    };
    const unscroll = () => {
      if (window.scrollY) window.scrollTo(0, 0);
    };
    sync();
    view.addEventListener("resize", settle);
    view.addEventListener("scroll", sync);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    window.addEventListener("scroll", unscroll, { passive: true });
    return () => {
      timers.forEach(clearTimeout);
      view.removeEventListener("resize", settle);
      view.removeEventListener("scroll", sync);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      window.removeEventListener("scroll", unscroll);
      root.classList.remove("keyboard-open");
    };
  }, []);
}

/** iPhones and iPads install from Safari's share menu; there's no prompt to show. */
export function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

type InstallState = "installed" | "prompt" | "ios" | "unavailable";

function readInstall(): InstallState {
  if (isStandalone()) return "installed";
  if (deferred) return "prompt";
  return isAppleMobile() ? "ios" : "unavailable";
}

export function useInstall() {
  const state = useSyncExternalStore(
    (l) => {
      installListeners.add(l);
      return () => installListeners.delete(l);
    },
    readInstall,
    () => "unavailable" as InstallState,
  );
  const install = async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    installListeners.forEach((l) => l());
    return outcome === "accepted";
  };
  return { state, install };
}

// ---- Push notifications --------------------------------------------------

export type PushState = "unsupported" | "needs-install" | "denied" | "off" | "on";

const pushListeners = new Set<() => void>();
let subscribed: boolean | null = null;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

async function checkSubscribed() {
  const reg = await registration();
  subscribed = Boolean(await reg?.pushManager?.getSubscription());
  pushListeners.forEach((l) => l());
}

function readPush(): PushState {
  const supported = "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  // On an iPhone, web push only works in the installed app.
  if (!supported) return isAppleMobile() && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return subscribed ? "on" : "off";
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Push notifications on this device, when Mach1 has push set up (data.pushKey). */
export function usePush() {
  const { data } = useShell();
  const state = useSyncExternalStore(
    (l) => {
      pushListeners.add(l);
      window.addEventListener("focus", l);
      if (subscribed === null) void checkSubscribed();
      return () => {
        pushListeners.delete(l);
        window.removeEventListener("focus", l);
      };
    },
    readPush,
    () => "unsupported" as PushState,
  );

  const turnOn = async (): Promise<string | null> => {
    if (!data.pushKey) return "Push notifications aren't set up for Mach1 yet.";
    if ((await Notification.requestPermission()) !== "granted") {
      pushListeners.forEach((l) => l());
      return "Notifications are blocked. Allow them in your settings for Mach1, then try again.";
    }
    const reg = (await registration()) ?? (await registerWorker());
    if (!reg) return "This browser can't receive notifications.";
    await navigator.serviceWorker.ready;
    try {
      const subscription =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(data.pushKey) }));
      const result = await subscribePushAction(subscription.toJSON() as Parameters<typeof subscribePushAction>[0], navigator.userAgent);
      if (result.error) return result.error;
    } catch {
      return "Couldn't turn on notifications on this device.";
    }
    await checkSubscribed();
    return null;
  };

  const turnOff = async () => {
    const subscription = await (await registration())?.pushManager.getSubscription();
    if (subscription) {
      await unsubscribePushAction(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe();
    }
    await checkSubscribed();
  };

  return { state: data.pushKey ? state : ("unsupported" as PushState), turnOn, turnOff };
}

/** Whether this device gets Mach1's push notifications (so the open app needn't show its own). */
export const pushOn = () => subscribed === true;

// ---- Setting up the device -----------------------------------------------

function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error) => {
    console.error("Service worker didn't register", error);
    return null;
  });
}

/**
 * Registers the service worker (in production builds: in development it would
 * cache code that's still changing), keeps the count of what waits on you on
 * the app's icon, and opens what a tapped notification points at.
 */
export function DeviceSetup() {
  const { data } = useShell();
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SERVICE_WORKER === "1") {
      void registerWorker().then(() => checkSubscribed());
    }
    const onMessage = (event: MessageEvent) => {
      const { type, path } = (event.data ?? {}) as { type?: string; path?: unknown };
      if (type === "mach:open" && typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) router.push(path);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    void (data.inboxCount > 0 ? nav.setAppBadge(data.inboxCount) : nav.clearAppBadge?.())?.catch(() => {});
  }, [data.inboxCount]);

  return null;
}

/** A line at the top while the connection is down: what you do waits and goes through when it's back. */
export function OfflineBanner() {
  const offline = useOffline();
  // Shown only after a moment, so a blip doesn't flash it.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!offline) return;
    const timer = setTimeout(() => setShown(true), 1200);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [offline]);
  if (!offline || !shown) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-ink px-4 pt-[calc(env(safe-area-inset-top)+0.375rem)] pb-1.5 text-xs text-bg"
    >
      <WifiOff size={13} />
      You&apos;re offline. What you do waits and goes through when you&apos;re back.
    </div>
  );
}
