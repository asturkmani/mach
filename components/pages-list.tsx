"use client";

import { Pin, PinOff } from "lucide-react";
import { useTransition } from "react";

import { setPinnedAction } from "@/app/(app)/pages/actions";
import { startCosMessage, useShell } from "@/components/shell/shell";
import type { PageIdea } from "@/lib/page-ideas";

export function PinToggle({ slug, pinned }: { slug: string; pinned: boolean }) {
  const { toast } = useShell();
  const [pending, startTransition] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setPinnedAction(slug, !pinned);
          if (result.error) toast(result.error);
        })
      }
      aria-label={pinned ? "Unpin from Home" : "Pin to Home"}
      title={pinned ? "Pinned to Home: click to take it off" : "Pin to Home's tabs"}
      className={`shrink-0 rounded p-1.5 hover:bg-hover ${pinned ? "text-ink" : "text-faint"}`}
    >
      {pinned ? <Pin size={15} strokeWidth={1.6} /> : <PinOff size={15} strokeWidth={1.6} />}
    </button>
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
        A page is a view of your data that the Chief of Staff builds for you and keeps up to date. Pin it and it becomes a tab on
        Home. Ask the Chief of Staff for one, or pick an idea:
      </p>
      {children}
    </div>
  );
}
