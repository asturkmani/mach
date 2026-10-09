"use client";

import { Lock, Users } from "lucide-react";
import { useTransition } from "react";

import { useShell } from "@/components/shell/shell";

// Who sees something: Private (its owner, and whoever it's shared with
// through its tasks) or Company (everyone). Whoever made it, or an admin,
// switches it with a click; everyone else just sees which it is.

export type Visibility = "company" | "private";

export function VisibilityToggle({
  visibility,
  canChange,
  change,
  privateMeans = "Only you and the people it's shared with",
}: {
  visibility: Visibility;
  canChange: boolean;
  /** Switches it; resolves with an error to show, if any. */
  change: (next: Visibility) => Promise<{ error?: string }>;
  /** What private means for this kind of thing, as a tooltip. */
  privateMeans?: string;
}) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const shared = visibility === "company";
  const title = shared ? "Everyone in the company can see this" : privateMeans;
  const content = (
    <>
      {shared ? <Users size={11} /> : <Lock size={11} />} {shared ? "Company" : "Private"}
    </>
  );
  if (!canChange) {
    return (
      <span className="label flex shrink-0 items-center gap-1 text-faint" title={title}>
        {content}
      </span>
    );
  }
  return (
    <button
      className="label flex shrink-0 items-center gap-1 text-faint hover:text-ink"
      title={`${title}. Click to ${shared ? "make it private" : "share it with the company"}.`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await change(shared ? "private" : "company");
          toast(result.error ?? (shared ? "Now private" : "Shared with the company"));
        })
      }
    >
      {content}
    </button>
  );
}
