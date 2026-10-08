"use client";

import { useEffect, useState } from "react";

import { Face } from "@/components/ui";

// Live signs that an agent is on a task: its status line (what it's doing now,
// with a running clock) and its reactions on the messages it picked up.

export type ReactionView = { agentId: string; agentName: string; emoji: string };

const REACTION_WORDS: Record<string, string> = {
  "👀": "is on it",
  "✅": "finished",
  "💬": "replied with a question",
  "🤝": "handed off",
  "⚠️": "hit a problem",
};

/** Seconds since a time, ticking; null until mounted, so the server render matches. */
function useElapsed(since: string | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!since) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [since]);
  if (!since || now === null) return null;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A run's elapsed time as a readout (monospace, tabular), ticking each second. */
export function Elapsed({ since, className }: { since: string | null; className?: string }) {
  const seconds = useElapsed(since);
  return seconds === null ? null : <span className={`readout ${className ?? ""}`}>{formatElapsed(seconds)}</span>;
}

/**
 * An agent at work: a short accent line crossing left to right. Along the
 * bottom edge of its parent (which must be positioned), or inline before words.
 */
export function Sweep({ inline = false, className = "" }: { inline?: boolean; className?: string }) {
  return <span className={`${inline ? "sweep-inline" : "sweep"} ${className}`} aria-hidden />;
}

/**
 * The agent's status at the foot of the thread, like someone typing: who,
 * what they're doing now, and for how long. Shown while a run goes, and
 * while one is starting after a reply.
 */
export function ThreadStatus({
  agent,
  activity,
  since,
  starting,
}: {
  agent: string;
  activity: string | null;
  since: string | null;
  starting: boolean;
}) {
  return (
    <li className="flex gap-3" aria-live="polite">
      <Face name={agent} agent size={26} />
      <div className="flex min-w-0 flex-1 items-center gap-2 pt-1 text-sm">
        <span>{agent}</span>
        <Sweep inline />
        <span className="min-w-0 truncate text-muted">{starting ? "Picking this up" : (activity ?? "Working")}</span>
        {!starting && <Elapsed since={since} className="ml-auto shrink-0 text-faint" />}
      </div>
    </li>
  );
}

/** Agents' reactions on a message: 👀 while they work on it, then how it went. */
export function Reactions({ reactions }: { reactions: ReactionView[] }) {
  if (!reactions.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {reactions.map((r) => {
        const words = `${r.agentName} ${REACTION_WORDS[r.emoji] ?? "reacted"}`;
        return (
          <span
            key={r.agentId}
            title={words}
            aria-label={words}
            className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-xs ${
              r.emoji === "👀" ? "border-accent/40 bg-accent-soft" : "border-line bg-raised"
            }`}
          >
            <span className="text-[13px] leading-none">{r.emoji}</span>
            <span className="text-muted">{r.agentName}</span>
          </span>
        );
      })}
    </div>
  );
}
