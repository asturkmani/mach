"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { searchTasksAction, type TaskHit } from "@/app/(app)/tasks/actions";
import { STATUS_WORDS } from "@/lib/task-words";

export type Command = {
  id: string;
  label: string;
  group: string;
  keys?: string[];
  run: () => void;
};

/** Every word typed must appear in the label, in any order. */
export function matches(label: string, query: string): boolean {
  const text = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export function Palette({
  mode,
  commands,
  onClose,
}: {
  mode: "commands" | "search";
  commands: Command[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TaskHit[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Tasks are searched on the server as you type (in search mode, with nothing typed, recent tasks show).
  useEffect(() => {
    if (mode === "commands" && !query.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await searchTasksAction(query);
      if (!cancelled) setHits(found);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, mode]);

  const rows = useMemo(() => {
    const taskRows: Command[] =
      mode === "commands" && !query.trim()
        ? []
        : hits.map((hit) => ({
            id: `task-${hit.id}`,
            group: "Tasks",
            label: `#${hit.number} ${hit.title}`,
            keys: [STATUS_WORDS[hit.status]],
            run: () => router.push(`/tasks/${hit.number}`),
          }));
    const commandRows = mode === "search" && !query.trim() ? [] : commands.filter((c) => matches(`${c.group} ${c.label}`, query));
    return mode === "search" ? [...taskRows, ...commandRows] : [...commandRows, ...taskRows];
  }, [commands, hits, query, mode, router]);

  const current = Math.min(selected, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="enter-drop w-full max-w-xl border border-line bg-raised shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
                e.preventDefault();
                setSelected(Math.min(current + 1, rows.length - 1));
              } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
                e.preventDefault();
                setSelected(Math.max(current - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(rows[current]);
              }
            }}
            placeholder={mode === "search" ? "Search tasks…" : "Type a command or search…"}
            className="h-14 w-full bg-transparent text-[17px] outline-none placeholder:text-faint"
          />
        </div>
        <div ref={listRef} className="scroll-quiet max-h-[50vh] overflow-y-auto py-1">
          {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">Nothing matches.</p>}
          {rows.map((row, index) => {
            const heading = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.id}>
                {heading && <p className="label px-4 pb-1 pt-3">{heading}</p>}
                <button
                  data-index={index}
                  onMouseMove={() => setSelected(index)}
                  onClick={() => run(row)}
                  className={`flex w-full items-center justify-between gap-4 px-4 py-2 text-left text-[15px] ${
                    index === current ? "bg-selected" : ""
                  }`}
                >
                  <span className="truncate">{row.label}</span>
                  {row.keys && (
                    <span className="flex shrink-0 gap-1">
                      {row.keys.map((key) => (
                        <kbd key={key} className="kbd">
                          {key}
                        </kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
