"use client";

import { Command, Plus } from "lucide-react";

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
    <header className="flex items-center justify-between gap-4 border-b border-line px-8 pb-5 pt-7">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate text-[22px] tracking-tight">{title}</h1>
        {count !== undefined && <span className="label">{count}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1 text-muted">
        {children}
        <button onClick={openNewTask} title="New task (N)" className="p-2 hover:text-ink">
          <Plus size={19} strokeWidth={1.5} />
        </button>
        <button onClick={() => openPalette()} title="Commands (⌘K)" className="p-2 hover:text-ink">
          <Command size={18} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}

/** The strip of key hints along the bottom of a list. */
export function KeyHints({ hints }: { hints: [keys: string[], word: string][] }) {
  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-8 py-2.5">
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
