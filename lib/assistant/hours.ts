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

/** How long before the window closes the last-chance keep-alive goes, when no working day starts or ends in time. */
const LAST_CALL = 3 * HOUR;

/**
 * Whether to send a keep-alive now: they last wrote within 24 hours and
 * there's been no nudge since. Normally at the start or end of their working
 * day, once it's been quiet for 12 hours or when the next such moment would
 * come after the window closes. When none comes before it closes (a message
 * late on a Friday, say), in the last few hours before it does, outside
 * quiet hours, so something always goes out in time.
 */
export function keepAliveDue(
  now: Date,
  { lastIn, lastNudge, timezone, hours }: { lastIn: Date | null; lastNudge: Date | null; timezone: string; hours: WorkHours },
): boolean {
  if (!lastIn) return false;
  const silent = now.getTime() - lastIn.getTime();
  const closes = lastIn.getTime() + 24 * HOUR - STEP;
  if (now.getTime() >= closes || (lastNudge && lastNudge > lastIn)) return false;
  if (isQuiet(now, timezone, hours)) return false;
  // The working-day edges, and the moments outside quiet hours, from now until the window closes.
  let nextEdge: number | null = null;
  let lastOpen = now.getTime();
  for (let t = now.getTime(); t < closes; t += STEP) {
    const at = new Date(t);
    if (!isQuiet(at, timezone, hours)) lastOpen = t;
    if (nextEdge === null && t > now.getTime() && atDayEdge(at, timezone, hours) && !atDayEdge(new Date(t - STEP), timezone, hours)) nextEdge = t;
  }
  if (atDayEdge(now, timezone, hours)) return silent >= 12 * HOUR || nextEdge === null;
  // No start or end of a working day before it closes: the last call.
  return nextEdge === null && lastOpen - now.getTime() <= LAST_CALL;
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
