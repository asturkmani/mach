"use client";

import { LayoutGrid, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useShell } from "@/components/shell/shell";

// The pages someone has open, as tabs across the top of a page, like a
// browser's: opening a page adds its tab, closing one takes it away, and the
// set is remembered in this browser.

const KEY = "mach-open-pages";
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

export function PageTabs({ current }: { current: string }) {
  const { data } = useShell();
  const router = useRouter();
  const stored = useOpenPages();
  const titles = useMemo(() => new Map(data.pages.map((p) => [p.slug, p.title])), [data.pages]);
  // Pages deleted since drop out; the one being looked at is always open.
  const open = [...stored.filter((slug) => titles.has(slug) && slug !== current), current].sort(
    (a, b) => (stored.indexOf(a) === -1 ? Infinity : stored.indexOf(a)) - (stored.indexOf(b) === -1 ? Infinity : stored.indexOf(b)),
  );

  useEffect(() => {
    if (!stored.includes(current)) write([...stored.filter((slug) => titles.has(slug)), current]);
  }, [current, stored, titles]);

  const close = (slug: string) => {
    const index = open.indexOf(slug);
    const rest = open.filter((s) => s !== slug);
    write(rest);
    if (slug === current) router.push(rest.length ? `/pages/${rest[Math.max(0, index - 1)]}` : "/pages");
  };

  return (
    <nav aria-label="Open pages" className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line px-2 pt-2 sm:px-4">
      <Link href="/pages" title="All pages" aria-label="All pages" className="flex items-center px-2.5 text-muted hover:text-ink">
        <LayoutGrid size={15} strokeWidth={1.6} />
      </Link>
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
    </nav>
  );
}
