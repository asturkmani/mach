"use client";

import { RotateCcw } from "lucide-react";
import { useState, useTransition } from "react";

import { pauseScheduleAction, removeScheduleAction, rerunAction, setScheduleAction } from "@/app/(app)/tasks/actions";
import { useShell } from "@/components/shell/shell";

// The Repeats panel on a job: its schedule, how each run works, and "Run
// again" for jobs with a run.sh.

export type ScheduleView = {
  cron: string;
  timezone: string;
  mode: "script" | "agent";
  paused: boolean;
  /** e.g. "At 16:00, Monday through Friday (Europe/London)". */
  description: string;
  /** Formatted on the server in the schedule's timezone, e.g. "Thu 8 Oct, 16:00". */
  nextRun: string | null;
};

type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "custom";

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "weekdays", label: "Every weekday" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "hourly", label: "Every hour" },
  { value: "custom", label: "Custom (cron)" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Draft = { frequency: Frequency; time: string; weekday: number; monthday: number; cron: string; timezone: string; mode: "script" | "agent" };

const pad = (n: string | number) => String(n).padStart(2, "0");

/** Reads a cron expression back into the editor's fields, falling back to custom. */
function parse(cron: string): Pick<Draft, "frequency" | "time" | "weekday" | "monthday"> {
  const base = { time: "16:00", weekday: 1, monthday: 1 };
  let m = cron.match(/^(\d+) (\d+) \* \* (\*|1-5|[0-6])$/);
  if (m) {
    const time = `${pad(m[2])}:${pad(m[1])}`;
    if (m[3] === "*") return { ...base, frequency: "daily", time };
    if (m[3] === "1-5") return { ...base, frequency: "weekdays", time };
    return { ...base, frequency: "weekly", time, weekday: Number(m[3]) };
  }
  m = cron.match(/^(\d+) (\d+) (\d+) \* \*$/);
  if (m) return { ...base, frequency: "monthly", time: `${pad(m[2])}:${pad(m[1])}`, monthday: Number(m[3]) };
  m = cron.match(/^(\d+) \* \* \* \*$/);
  if (m) return { ...base, frequency: "hourly", time: `00:${pad(m[1])}` };
  return { ...base, frequency: "custom" };
}

function build(d: Draft): string {
  const [h, m] = d.time.split(":").map(Number);
  switch (d.frequency) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${d.weekday}`;
    case "monthly":
      return `${m} ${h} ${d.monthday} * *`;
    case "hourly":
      return `${m} * * * *`;
    default:
      return d.cron.trim();
  }
}

export function RepeatsPanel({
  taskId,
  schedule,
  canRerun,
  busy,
  defaultTimezone,
}: {
  taskId: string;
  schedule: ScheduleView | null;
  canRerun: boolean;
  /** Running or archived: nothing can start now. */
  busy: boolean;
  defaultTimezone: string | null;
}) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);

  const act = (work: () => Promise<{ error?: string }>, done?: string, after?: () => void) =>
    start(async () => {
      const result = await work();
      if (result.error) return toast(result.error);
      if (done) toast(done);
      after?.();
    });

  const edit = () =>
    setDraft({
      ...parse(schedule?.cron ?? "0 16 * * 1-5"),
      cron: schedule?.cron ?? "0 16 * * 1-5",
      timezone: schedule?.timezone ?? defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      mode: schedule?.mode ?? "script",
    });

  const save = (d: Draft) =>
    act(() => setScheduleAction(taskId, { cron: build(d), timezone: d.timezone.trim(), mode: d.mode }), "Schedule saved", () => setDraft(null));

  const rerun = canRerun && (
    <button
      onClick={() => act(() => rerunAction(taskId), "Running the script again")}
      disabled={pending || busy}
      className="btn btn-ghost mt-3 w-full justify-center"
      title="Replay run.sh now, without the agent unless it fails"
    >
      <RotateCcw size={13} /> Run script again
    </button>
  );

  if (draft) return <ScheduleEditor draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} pending={pending} />;

  if (!schedule) {
    return (
      <div>
        <button onClick={edit} className="text-sm text-faint hover:text-ink">
          Doesn&apos;t repeat. Set a schedule…
        </button>
        {rerun}
      </div>
    );
  }

  const [words, zone] = [schedule.description.replace(/ \([^)]*\)$/, ""), schedule.timezone];
  return (
    <div className="space-y-1.5 text-sm">
      <p>{words}</p>
      <p className="text-xs text-faint">{zone}</p>
      <p className="text-xs text-muted">
        {schedule.paused ? "Paused" : schedule.nextRun ? `Next run ${schedule.nextRun}` : "No more runs"}
      </p>
      <p className="text-xs text-faint">
        {schedule.mode === "script" ? "Replays run.sh; the agent steps in if it fails." : "The agent does the job each time."}
      </p>
      <div className="flex gap-3 pt-1">
        <button onClick={edit} className="label hover:text-ink">
          Edit
        </button>
        <button
          onClick={() => act(() => pauseScheduleAction(taskId, !schedule.paused), schedule.paused ? "Resumed" : "Paused")}
          disabled={pending}
          className="label hover:text-ink"
        >
          {schedule.paused ? "Resume" : "Pause"}
        </button>
        <button
          onClick={() => confirm("Stop this job repeating?") && act(() => removeScheduleAction(taskId), "Stopped repeating")}
          disabled={pending}
          className="label hover:text-danger"
        >
          Stop
        </button>
      </div>
      {rerun}
    </div>
  );
}

function ScheduleEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  pending,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <select value={draft.frequency} onChange={(e) => set({ frequency: e.target.value as Frequency })} className="field py-1.5">
        {FREQUENCIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {draft.frequency === "weekly" && (
        <select value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} className="field py-1.5">
          {WEEKDAYS.map((day, i) => (
            <option key={day} value={i}>
              on {day}
            </option>
          ))}
        </select>
      )}
      {draft.frequency === "monthly" && (
        <select value={draft.monthday} onChange={(e) => set({ monthday: Number(e.target.value) })} className="field py-1.5">
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              on day {d}
            </option>
          ))}
        </select>
      )}
      {draft.frequency === "custom" ? (
        <input
          value={draft.cron}
          onChange={(e) => set({ cron: e.target.value })}
          placeholder="0 16 * * 1-5"
          className="field py-1.5 font-mono text-xs"
          title="minute hour day-of-month month day-of-week"
        />
      ) : draft.frequency === "hourly" ? (
        <label className="flex items-center gap-2 text-sm text-muted">
          at minute
          <input
            type="number"
            min={0}
            max={59}
            value={Number(draft.time.split(":")[1])}
            onChange={(e) => set({ time: `00:${pad(Math.min(59, Math.max(0, Number(e.target.value))))}` })}
            className="field w-20 py-1.5"
          />
        </label>
      ) : (
        <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} className="field py-1.5" required />
      )}
      <input
        value={draft.timezone}
        onChange={(e) => set({ timezone: e.target.value })}
        list="mach-timezones"
        className="field py-1.5 text-xs"
        title="Timezone"
        required
      />
      <datalist id="mach-timezones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Draft["mode"] })} className="field py-1.5 text-xs">
        <option value="script">Each run replays run.sh</option>
        <option value="agent">The agent does it each time</option>
      </select>
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">
          Save
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}
