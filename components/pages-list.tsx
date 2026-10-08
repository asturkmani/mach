"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

import { lastPage } from "@/components/page-tabs";
import { startCosMessage, useShell } from "@/components/shell/shell";
import { useMounted } from "@/components/ui";
import type { PageIdea } from "@/lib/page-ideas";

/**
 * Pages in the left menu: back to the page looked at last, in its tabs. With
 * no tabs open, the company's pages to pick from; with none yet, how to make one.
 */
export function PagesHome({ pages, children }: { pages: { slug: string; title: string; description: string }[]; children: React.ReactNode }) {
  const router = useRouter();
  const { setCosOpen } = useShell();
  // Open tabs are remembered in this browser, so where to go is only known once mounted.
  const mounted = useMounted();
  const target = mounted ? lastPage(pages.map((p) => p.slug)) : null;
  useEffect(() => {
    if (target) router.replace(`/pages/${target}`);
  }, [target, router]);
  if (pages.length === 0) return <PagesEmpty>{children}</PagesEmpty>;
  if (!mounted || target) return null;
  return (
    <div className="mx-auto max-w-lg space-y-6 py-6">
      <ul className="divide-y divide-line-soft border border-line bg-raised">
        {pages.map((page) => (
          <li key={page.slug}>
            <Link href={`/pages/${page.slug}`} className="block px-4 py-3 hover:bg-hover">
              <span className="block text-[15px]">{page.title}</span>
              {page.description && <span className="block truncate text-sm text-muted">{page.description}</span>}
            </Link>
          </li>
        ))}
      </ul>
      <button onClick={() => startCosMessage("Build me a page: ", setCosOpen)} className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
        + New page
      </button>
      <section className="space-y-3">
        <h2 className="label">Ideas</h2>
        {children}
      </section>
    </div>
  );
}

/** Ideas written for this company; picking one starts the request in the Chief of Staff. */
export function PageIdeaList({ ideas }: { ideas: PageIdea[] }) {
  const { setCosOpen } = useShell();
  if (ideas.length === 0) return null;
  return (
    <ul className="space-y-2 text-left">
      {ideas.map((idea) => (
        <li key={idea.title}>
          <button
            onClick={() =>
              startCosMessage(
                idea.needsConnecting ? `Connect ${idea.needsConnecting}, then: ${idea.prompt}` : idea.prompt,
                setCosOpen,
              )
            }
            className="w-full border border-line bg-raised px-4 py-2.5 text-left hover:bg-hover"
          >
            <span className="block text-sm">{idea.title}</span>
            <span className="label mt-1 block truncate text-faint">
              {idea.needsConnecting ? `Connect ${idea.needsConnecting} first` : `From ${idea.source}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IdeasLoading() {
  return <p className="label animate-pulse text-faint">Thinking of pages for you…</p>;
}

export function PagesEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-10 text-center">
      <p className="text-[17px]">No pages yet.</p>
      <p className="text-sm text-muted">
        A page is a report on your data that the Chief of Staff builds for you and keeps up to date. Open pages sit in tabs. Ask
        the Chief of Staff for one, or pick an idea:
      </p>
      {children}
    </div>
  );
}
