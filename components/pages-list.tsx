"use client";

import { startCosMessage, useShell } from "@/components/shell/shell";
import type { PageIdea } from "@/lib/page-ideas";

/**
 * A page as a small live picture of itself: its frame drawn at desktop size
 * and scaled down, not clickable (the card around it is the link).
 */
export function PageThumbnail({ slug, title }: { slug: string; title: string }) {
  const { theme } = useShell();
  return (
    <div className="relative aspect-[16/10] overflow-hidden bg-panel">
      <iframe
        src={`/pages/${slug}/frame${theme === "system" ? "" : `?theme=${theme}`}`}
        title={`${title} (preview)`}
        sandbox="allow-scripts"
        loading="lazy"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0"
      />
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
        A page is a report on your data that the Chief of Staff builds for you and keeps up to date. Ask the Chief of Staff for
        one, or pick an idea:
      </p>
      {children}
    </div>
  );
}
