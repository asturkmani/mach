"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While agents are working, re-renders the page every few seconds so their progress shows. */
export function LiveRefresh({ active, every = 4000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, every);
    return () => clearInterval(timer);
  }, [active, every, router]);
  return null;
}
