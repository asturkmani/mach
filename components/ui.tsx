"use client";

import { useSyncExternalStore } from "react";

import type { Priority } from "@/lib/task-words";

// Small pieces used across the app.

const noop = () => () => {};

/** True after hydration, so browser-only values (local time) don't mismatch the server render. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** "6:59 PM" today, "Mon 6:59 PM" this week, "Oct 3" before that; in the viewer's time zone. */
export function formatWhen(date: Date | string, now = new Date()): string {
  const d = new Date(date);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (days < 6 && days > 0) {
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function When({ date, className }: { date: Date | string; className?: string }) {
  const mounted = useMounted();
  return (
    <time dateTime={new Date(date).toISOString()} className={className}>
      {mounted ? formatWhen(date) : ""}
    </time>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

/** People are round, agents are square, so you can tell them apart at a glance. */
export function Face({
  name,
  agent = false,
  size = 22,
  title,
}: {
  name: string;
  agent?: boolean;
  size?: number;
  title?: string;
}) {
  return (
    <span
      title={title ?? name}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4) }}
      className={`inline-flex shrink-0 items-center justify-center border font-mono leading-none ${
        agent ? "rounded-[3px] border-accent/50 bg-accent-soft text-accent" : "rounded-full border-line bg-raised text-muted"
      }`}
    >
      {initials(name)}
    </span>
  );
}

const PRIORITY_BARS: Record<Priority, number> = { urgent: 4, high: 3, medium: 2, low: 1 };

export function PriorityMark({ priority, className = "" }: { priority: Priority; className?: string }) {
  if (priority === "urgent") {
    return (
      <span
        title="Urgent"
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[2px] bg-accent font-mono text-[10px] font-bold text-panel ${className}`}
      >
        !
      </span>
    );
  }
  const bars = PRIORITY_BARS[priority];
  return (
    <span title={priority[0].toUpperCase() + priority.slice(1)} className={`inline-flex h-3.5 items-end gap-[2px] ${className}`}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={`w-[3px] ${n <= bars ? "bg-muted" : "bg-line"}`} style={{ height: 4 + n * 3 }} />
      ))}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// Per-viewer preferences kept in localStorage, readable during render without hydration mismatches.
const preferenceListeners = new Set<() => void>();
const subscribePreference = (listener: () => void) => {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
};

export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const stored = useSyncExternalStore(
    subscribePreference,
    () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const value = stored === null ? fallback : stored === "1";
  const set = (next: boolean) => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Storage can be unavailable (private windows); the choice just won't stick.
    }
    preferenceListeners.forEach((l) => l());
  };
  return [value, set];
}
