"use client";

import { Pin, PinOff } from "lucide-react";
import { useTransition } from "react";

import { setPinnedAction } from "@/app/(app)/pages/actions";
import { startCosMessage, useShell } from "@/components/shell/shell";

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

const EXAMPLES = [
  "Net worth by entity and asset class from Masttro, refreshed every weekday at 7am",
  "Our cash across all bank accounts, with the biggest moves this week",
  "Open tasks by person, and what's overdue",
];

export function PagesEmpty() {
  const { setCosOpen } = useShell();
  return (
    <div className="mx-auto max-w-lg space-y-4 py-10 text-center">
      <p className="text-[17px]">No pages yet.</p>
      <p className="text-sm text-muted">
        A page is a view of your data that the Chief of Staff builds for you and keeps up to date. Pin it and it becomes a tab on
        Home. Ask for one, for example:
      </p>
      <ul className="space-y-2 text-left">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              onClick={() => startCosMessage(`Build me a page: ${example}`, setCosOpen)}
              className="w-full border border-line bg-raised px-4 py-2.5 text-left text-sm hover:bg-hover"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
