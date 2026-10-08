"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps the page current: every few seconds while agents are working and the
 * tab is in view, so their progress shows, and every half minute otherwise,
 * including in the background, so work that finishes or starts on a schedule
 * reaches the inbox (and its notification). Also refreshes when the tab comes
 * back into view.
 */
export function LiveRefresh({ running, busyEvery = 4000, idleEvery = 30_000 }: { running: boolean; busyEvery?: number; idleEvery?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    const timer = setInterval(() => {
      const fast = running && document.visibilityState === "visible";
      if (fast || Date.now() - last >= idleEvery) refresh();
    }, running ? busyEvery : idleEvery);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [running, busyEvery, idleEvery, router]);
  return null;
}
