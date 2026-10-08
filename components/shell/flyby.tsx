"use client";

import { useEffect, useState } from "react";

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
        <X1 />
      </div>
    </div>
  );
}

/** The X-1 in profile, nose right: a bullet of a fuselage, straight wing, tall fin, and its shock cone. */
function X1() {
  return (
    <svg width="78" height="26" viewBox="0 0 78 26" fill="none">
      {/* The Mach cone off the nose. */}
      <path d="M73 13 Q56 6 30 1 M73 13 Q56 20 30 25" stroke="var(--faint)" strokeWidth="0.6" strokeLinecap="round" opacity="0.4" />
      {/* Exhaust. */}
      <path d="M2 13.5 H11" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
      {/* Tail fin and stabiliser. */}
      <path d="M14 12 L17 3 H22 L24 11 Z" fill="#c9581f" />
      <path d="M13 14 L25 14 L22 16 L15 16 Z" fill="#b84f1b" />
      {/* Fuselage: a .50-calibre bullet, which is what it was shaped after. */}
      <path d="M11 11 H52 C62 11 68 12 72 13.2 C68 14.6 62 16 52 16 H11 C10 16 10 11 11 11 Z" fill="#e8732a" />
      {/* Canopy, flush with the nose. */}
      <path d="M53 11.2 C56 10 59 10.2 61 11.6" stroke="#f6c39c" strokeWidth="1.2" strokeLinecap="round" />
      {/* The straight, thin wing. */}
      <path d="M33 14.5 L46 14.5 L43 18.5 L36 18.5 Z" fill="#b84f1b" />
    </svg>
  );
}
