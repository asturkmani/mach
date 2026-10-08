"use client";

import { Command, Plus } from "lucide-react";

import { CosToggle } from "@/components/shell/cos-toggle";
import { useShell } from "@/components/shell/shell";

export function PageHeader({
  title,
  count,
  children,
}: {
  title: React.ReactNode;
  count?: number;
  children?: React.ReactNode;
}) {
  const { openNewTask, openPalette } = useShell();
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line px-4 pt-5 pb-4 sm:px-8 sm:pt-7 sm:pb-5">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-[22px] font-medium tracking-tight">{title}</h1>
        {count !== undefined && <span className="label">{count}</span>}
      </div>
      <div className="flex max-w-full shrink-0 items-center gap-1 text-muted">
        {children}
        {/* On a phone these are in the bar at the bottom. */}
        <button onClick={openNewTask} title="New task (N)" className="hidden p-2 hover:text-ink md:block">
          <Plus size={19} strokeWidth={1.5} />
        </button>
        <button onClick={() => openPalette()} title="Commands (⌘K)" className="hidden p-2 hover:text-ink md:block">
          <Command size={18} strokeWidth={1.5} />
        </button>
        <CosToggle />
      </div>
    </header>
  );
}

/** The strip of key hints along the bottom of a list. */
export function KeyHints({ hints }: { hints: [keys: string[], word: string][] }) {
  return (
    <footer className="hidden flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 sm:px-8 md:flex">
      {hints.map(([keys, word]) => (
        <span key={word} className="flex items-center gap-1.5 text-xs text-faint">
          {keys.map((k) => (
            <kbd key={k} className="kbd">
              {k}
            </kbd>
          ))}
          <span>{word}</span>
        </span>
      ))}
    </footer>
  );
}
