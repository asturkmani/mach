"use client";

import { Lightbulb, MessageSquare, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { startCosMessage, useShell } from "@/components/shell/shell";
import type { PageIdea } from "@/lib/page-ideas";

// The pages someone has open, as tabs across the top of a page, like a
// browser's: opening a page adds its tab, closing one takes it away, and the
// set is remembered in this browser.

const KEY = "mach-open-pages";
/** The page looked at last, which Pages in the left menu opens. */
const LAST_KEY = "mach-last-page";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function write(slugs: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(slugs));
  } catch {
    // Private windows can refuse storage; the tabs just won't be remembered.
  }
  listeners.forEach((listener) => listener());
}

function parse(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Where Pages in the left menu goes: the page looked at last if it's still open, else another open one. */
export function lastPage(slugs: string[]): string | null {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {}
  const open = parse(read()).filter((slug) => slugs.includes(slug));
  return (last && open.includes(last) ? last : open.at(-1)) ?? null;
}

function useOpenPages(): string[] {
  const raw = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => "[]",
  );
  return useMemo(() => parse(raw), [raw]);
}

export function PageTabs({ current, ideas }: { current: string; ideas: PageIdea[] }) {
  const { data } = useShell();
  const router = useRouter();
  const stored = useOpenPages();
  const titles = useMemo(() => new Map(data.pages.map((p) => [p.slug, p.title])), [data.pages]);
  // Pages deleted since drop out; the one being looked at is always open.
  const open = [...stored.filter((slug) => titles.has(slug) && slug !== current), current].sort(
    (a, b) => (stored.indexOf(a) === -1 ? Infinity : stored.indexOf(a)) - (stored.indexOf(b) === -1 ? Infinity : stored.indexOf(b)),
  );

  // The page being closed stays on screen until the next one loads: don't open its tab again meanwhile.
  const closing = useRef<string | null>(null);
  useEffect(() => {
    if (closing.current === current) return;
    // Read storage itself: while the page hydrates, `stored` is still the empty server value.
    const saved = parse(read());
    if (!saved.includes(current)) write([...saved.filter((slug) => titles.has(slug)), current]);
  }, [current, stored, titles]);
  useEffect(() => {
    try {
      localStorage.setItem(LAST_KEY, current);
    } catch {}
  }, [current]);

  const close = (slug: string) => {
    const index = open.indexOf(slug);
    const rest = open.filter((s) => s !== slug);
    if (slug === current) closing.current = slug;
    write(rest);
    if (slug === current) router.push(rest.length ? `/pages/${rest[Math.max(0, index - 1)]}` : "/pages");
  };

  return (
    <nav aria-label="Open pages" className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line px-4 pt-3 sm:px-8">
      {open.map((slug) => {
        const on = slug === current;
        return (
          <div
            key={slug}
            className={`group -mb-px flex max-w-56 shrink-0 items-center gap-1 border border-b-0 pl-3 text-sm ${
              on ? "border-line bg-panel text-ink" : "border-transparent text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <Link href={`/pages/${slug}`} aria-current={on ? "page" : undefined} className="truncate py-2">
              {titles.get(slug) ?? slug}
            </Link>
            <button
              onClick={() => close(slug)}
              aria-label={`Close ${titles.get(slug) ?? slug}`}
              title="Close"
              className={`rounded p-1.5 hover:bg-selected ${on ? "" : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"}`}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <NewPage ideas={ideas} />
    </nav>
  );
}

/** "+" at the end of the tabs: describe a page to the Chief of Staff, or start from an idea written for this company. */
function NewPage({ ideas }: { ideas: PageIdea[] }) {
  const { setCosOpen } = useShell();
  // Shown fixed under the button: the tab strip scrolls sideways, which would clip a menu inside it.
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const ask = (text: string) => {
    setOpen(null);
    startCosMessage(text, setCosOpen);
  };
  const row = "flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink";
  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { top: box.bottom + 4, left: Math.max(8, Math.min(box.left, window.innerWidth - 328)) });
        }}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-label="New page"
        title="New page"
        className="ml-1 rounded p-1.5 text-muted hover:bg-hover hover:text-ink"
      >
        <Plus size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <div role="menu" style={open} className="enter-drop fixed z-30 w-80 border border-line bg-panel py-1 shadow-[var(--shadow)]">
          <button role="menuitem" onClick={() => ask("Build me a page: ")} className={row}>
            <MessageSquare size={15} strokeWidth={1.6} className="mt-0.5 shrink-0" />
            Describe a new page to the Chief of Staff
          </button>
          {ideas.length > 0 && (
            <>
              <p className="label px-3 pt-3 pb-1">Ideas</p>
              {ideas.map((idea) => (
                <button
                  key={idea.title}
                  role="menuitem"
                  onClick={() => ask(idea.needsConnecting ? `Connect ${idea.needsConnecting}, then: ${idea.prompt}` : idea.prompt)}
                  className={row}
                >
                  <Lightbulb size={15} strokeWidth={1.6} className="mt-0.5 shrink-0" />
                  <span>
                    {idea.title}
                    {idea.needsConnecting && <span className="block text-xs text-faint">Connect {idea.needsConnecting} first</span>}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
