"use client";

import Link from "next/link";

import { useShell } from "@/components/shell/shell";

/**
 * Home's tabs: the work, then each pinned page. Shown on Home and on pinned
 * pages, and only once the company has pinned a page.
 */
export function PageTabs({ active }: { active: string | null }) {
  const { data } = useShell();
  const pinned = data.pages.filter((p) => p.pinned);
  if (pinned.length === 0) return null;
  const tab = (href: string, label: string, on: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={on ? "page" : undefined}
      className={`-mb-px shrink-0 border-b-2 px-1 py-2.5 text-sm whitespace-nowrap ${
        on ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Home tabs" className="flex shrink-0 gap-5 overflow-x-auto border-b border-line px-4 sm:px-8">
      {tab("/", "Work", active === null)}
      {pinned.map((p) => tab(`/pages/${p.slug}`, p.title, active === p.slug))}
    </nav>
  );
}
