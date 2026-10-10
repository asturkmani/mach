// A person's working and quiet hours, in their own timezone, and when their
// assistant may message them: nothing in quiet hours; answers they're needed
// for any other time; everything else during working hours. Keep-alive
// messages (so WhatsApp's 24-hour window doesn't close) go near the start or
// end of the working day, when people tend to reply.

export type WorkHours = {
  /** ISO weekdays they work: 1 is Monday, 7 is Sunday. */
  days: number[];
  /** "09:00" */
  start: string;
  end: string;
  /** Never message between these, e.g. "21:00" to "08:00". */
  quietStart: string;
  quietEnd: string;
};

export const DEFAULT_HOURS: WorkHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", quietStart: "21:00", quietEnd: "08:00" };

const HOUR = 3_600_000;
const STEP = 15 * 60_000;
/** How close to the start or end of the working day a keep-alive goes out. */
const EDGE_MINUTES = 60;

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h % 24) * 60 + (m || 0);
};

export function validHours(input: Partial<WorkHours>): WorkHours {
  const time = (value: string | undefined, fallback: string) => (value && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value) ? value.padStart(5, "0") : fallback);
  const days = (input.days ?? DEFAULT_HOURS.days).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return {
    days: days.length ? [...new Set(days)].sort() : DEFAULT_HOURS.days,
    start: time(input.start, DEFAULT_HOURS.start),
    end: time(input.end, DEFAULT_HOURS.end),
    quietStart: time(input.quietStart, DEFAULT_HOURS.quietStart),
    quietEnd: time(input.quietEnd, DEFAULT_HOURS.quietEnd),
  };
}

/** The weekday (1–7, Monday first) and minute of the day at this moment where they are. */
export function localTime(at: Date, timezone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Whether a minute of the day falls in [from, to), across midnight if need be. */
const within = (minutes: number, from: number, to: number) => (from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to);

export function isQuiet(at: Date, timezone: string, hours: WorkHours): boolean {
  return within(localTime(at, timezone).minutes, minutesOf(hours.quietStart), minutesOf(hours.quietEnd));
}

export function isWorking(at: Date, timezone: string, hours: WorkHours): boolean {
  const { weekday, minutes } = localTime(at, timezone);
  return hours.days.includes(weekday) && within(minutes, minutesOf(hours.start), minutesOf(hours.end)) && !isQuiet(at, timezone, hours);
}

/** The first hour of their working day, or its last hour. */
export function atDayEdge(at: Date, timezone: string, hours: WorkHours): boolean {
  if (!isWorking(at, timezone, hours)) return false;
  const { minutes } = localTime(at, timezone);
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  return within(minutes, start, (start + EDGE_MINUTES) % 1440) || within(minutes, (end - EDGE_MINUTES + 1440) % 1440, end);
}

/** The first moment at or after `from` (to 15 minutes) when `ok` holds, looking up to 8 days ahead. */
function next(from: Date, ok: (at: Date) => boolean): Date {
  for (let t = from.getTime(), limit = t + 8 * 24 * HOUR; t < limit; t += STEP) if (ok(new Date(t))) return new Date(t);
  return from;
}

/**
 * When something can reach them: now, unless it's quiet hours (then when
 * they end) or, for anything that can wait, outside working hours (then
 * when work starts).
 */
export function deliverAt(now: Date, timezone: string, hours: WorkHours, { urgent }: { urgent: boolean }): Date {
  return urgent ? next(now, (at) => !isQuiet(at, timezone, hours)) : next(now, (at) => isWorking(at, timezone, hours));
}

/**
 * Whether to send a keep-alive now: they last wrote within 24 hours, there's
 * been no nudge since, and it's the start or end of their working day, and
 * either it's been quiet for 12 hours or the next such moment would come
 * after the window closes.
 */
export function keepAliveDue(
  now: Date,
  { lastIn, lastNudge, timezone, hours }: { lastIn: Date | null; lastNudge: Date | null; timezone: string; hours: WorkHours },
): boolean {
  if (!lastIn) return false;
  const silent = now.getTime() - lastIn.getTime();
  if (silent >= 24 * HOUR || (lastNudge && lastNudge > lastIn)) return false;
  if (!atDayEdge(now, timezone, hours)) return false;
  if (silent >= 12 * HOUR) return true;
  // Skip past the edge we're in, then find the next one: if it's after the window closes, now is the last chance.
  const after = next(now, (at) => !atDayEdge(at, timezone, hours));
  const following = next(after, (at) => atDayEdge(at, timezone, hours));
  return following.getTime() >= lastIn.getTime() + 24 * HOUR - STEP;
}

/** "Mon–Fri 09:00–18:00, quiet 21:00–08:00 (Europe/London)". */
export function describeHours(hours: WorkHours, timezone: string): string {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days =
    hours.days.length === 5 && hours.days.join() === "1,2,3,4,5"
      ? "Mon–Fri"
      : hours.days.length === 7
        ? "every day"
        : hours.days.map((d) => names[d - 1]).join(", ");
  return `${days} ${hours.start}–${hours.end}, quiet ${hours.quietStart}–${hours.quietEnd} (${timezone})`;
}
