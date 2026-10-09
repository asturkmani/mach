"use client";

import { useTransition } from "react";

import { setAutoJoinAction } from "@/app/(app)/settings/actions";
import { useShell } from "@/components/shell/shell";

/** The switch for colleagues joining on their own (on) or asking an admin (off). */
export function AutoJoinToggle({ on, domain }: { on: boolean; domain: string }) {
  const { toast } = useShell();
  const [pending, startTransition] = useTransition();
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={`Anyone with an @${domain} email joins without asking`}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setAutoJoinAction(!on);
          toast(result.error ?? (on ? "Colleagues now ask to join, and an admin lets them in." : `Anyone with an @${domain} email now joins on their own.`));
        })
      }
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${on ? "border-ink bg-ink" : "border-line bg-raised"}`}
    >
      <span className={`absolute top-0.5 size-[18px] rounded-full transition-[left] ${on ? "left-[22px] bg-panel" : "left-0.5 bg-muted"}`} />
    </button>
  );
}
