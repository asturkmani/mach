"use client";

import { useEffect, useState } from "react";

import { X1Plane } from "@/components/brand";

// An Easter egg: when a task is marked done, the Bell X-1 crosses the top of
// the screen, the plane Chuck Yeager flew past Mach 1 on 14 October 1947.
// Skipped for anyone who asks their system for less motion.

const EVENT = "mach:task-done";

/** Call when someone marks a task done. */
export function celebrateDone(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function Flyby() {
  const [flight, setFlight] = useState(0);
  useEffect(() => {
    const go = () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      setFlight((n) => n + 1);
    };
    window.addEventListener(EVENT, go);
    return () => window.removeEventListener(EVENT, go);
  }, []);
  if (flight === 0) return null;
  return (
    <div key={flight} aria-hidden className="pointer-events-none fixed inset-x-0 top-6 z-50 overflow-hidden">
      <div className="flyby flex w-max items-center gap-2" onAnimationEnd={() => setFlight(0)}>
        <span className="font-mono text-[10px] tracking-wider text-faint uppercase">Bell X-1 · Mach 1 · 14 Oct 1947</span>
        <X1Plane />
      </div>
    </div>
  );
}
