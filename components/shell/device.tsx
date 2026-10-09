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
 * An iPhone home-screen app keeps the smaller height it had while the keyboard
 * was open (a WebKit bug): the bottom bar floats up over a dead band until the
 * app is restarted. When the keyboard closes and the window is still shorter
 * than it has been at this width, hiding and showing the full-height frame for
 * a moment makes WebKit measure the screen again. Scroll positions are kept.
 */
export function useKeyboardViewportFix(frame: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!isStandalone() || !isAppleMobile()) return;
    const tallest = new Map<number, number>();
    const measure = () => tallest.set(window.innerWidth, Math.max(tallest.get(window.innerWidth) ?? 0, window.innerHeight));
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      const view = frame.current;
      if (!view || (tallest.get(window.innerWidth) ?? 0) - window.innerHeight <= 4) return;
      const scrolled = [...view.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollTop > 0).map((el) => [el, el.scrollTop] as const);
      view.style.display = "none";
      void view.offsetHeight; // a synchronous reflow is what makes WebKit recompute the viewport
      view.style.display = "";
      for (const [el, top] of scrolled) el.scrollTop = top;
    };
    const onBlur = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.matches?.("input, textarea, select, [contenteditable=true]")) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Still typing somewhere else (focus moved to another field): the keyboard is open.
        if ((document.activeElement as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable=true]")) return;
        restore();
      }, 150);
    };
    window.addEventListener("resize", measure);
    document.addEventListener("focusout", onBlur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
      document.removeEventListener("focusout", onBlur);
    };
  }, [frame]);
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
