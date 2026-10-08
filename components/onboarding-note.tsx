"use client";

import { useShell } from "@/components/shell/shell";

export function OnboardingNote() {
  const { cosOpen, setCosOpen } = useShell();
  return (
    <div className="mx-8 mt-5 flex items-center justify-between gap-4 border border-accent/40 bg-accent-soft px-4 py-3">
      <p className="text-[15px]">
        Finish setting up with your Chief of Staff: what you do, who&apos;s on the team and your top priorities.
      </p>
      {!cosOpen && (
        <button onClick={() => setCosOpen(true)} className="btn shrink-0">
          Open <kbd className="kbd">C</kbd>
        </button>
      )}
    </div>
  );
}
