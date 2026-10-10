"use client";

import { useState, useTransition } from "react";

import { saveWorkHoursAction } from "@/app/(app)/settings/actions";
import { describeHours, type WorkHours } from "@/lib/assistant/hours";

// When your assistant may message you first, in Settings → Account: it tells
// you about finished work in your working hours, about anything that needs
// you any time but your quiet hours, and never in them.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function zones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function WorkHoursSetting({ timezone, hours, saved }: { timezone: string; hours: WorkHours; saved: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ timezone, ...hours });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  if (!editing) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink">{describeHours(hours, timezone)}</p>
        {!saved && <p className="text-xs text-faint">The company&apos;s timezone and office hours, until you set yours.</p>}
        <button
          className="btn"
          onClick={() => {
            setDraft({ timezone, ...hours });
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>
    );
  }
  const time = (label: string, key: "start" | "end" | "quietStart" | "quietEnd") => (
    <label className="flex flex-col gap-1 text-xs text-faint">
      {label}
      <input type="time" value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} className="field" />
    </label>
  );
  return (
    <div className="space-y-4">
      <label className="flex flex-col gap-1 text-xs text-faint">
        Timezone
        <input list="work-hours-zones" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} className="field" />
        <datalist id="work-hours-zones">
          {zones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Working days">
        {DAYS.map((name, i) => {
          const day = i + 1;
          const on = draft.days.includes(day);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              className={on ? "btn btn-primary" : "btn"}
              onClick={() => set({ days: on ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort() })}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {time("Work starts", "start")}
        {time("Work ends", "end")}
        {time("Quiet from", "quietStart")}
        {time("Quiet until", "quietEnd")}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const { timezone: tz, ...rest } = draft;
              const result = await saveWorkHoursAction(tz, rest);
              if (result.error) setError(result.error);
              else {
                setError(null);
                setEditing(false);
              }
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
