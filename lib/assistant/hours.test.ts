import { describe, expect, it } from "vitest";

import { DEFAULT_HOURS, atDayEdge, deliverAt, describeHours, isQuiet, keepAliveDue, validHours } from "./hours";

// London is on BST (UTC+1) in October 2026, until the 25th. 12 October is a Monday.
const LONDON = "Europe/London";
const at = (iso: string) => new Date(iso);

describe("a person's hours", () => {
  it("knows quiet hours and the edges of the working day where they are", () => {
    expect(isQuiet(at("2026-10-12T21:30:00Z"), LONDON, DEFAULT_HOURS)).toBe(true); // 22:30
    expect(isQuiet(at("2026-10-12T07:30:00Z"), LONDON, DEFAULT_HOURS)).toBe(false); // 08:30
    expect(atDayEdge(at("2026-10-12T08:15:00Z"), LONDON, DEFAULT_HOURS)).toBe(true); // 09:15
    expect(atDayEdge(at("2026-10-12T12:00:00Z"), LONDON, DEFAULT_HOURS)).toBe(false); // 13:00
    expect(atDayEdge(at("2026-10-12T16:30:00Z"), LONDON, DEFAULT_HOURS)).toBe(true); // 17:30
    expect(atDayEdge(at("2026-10-10T08:15:00Z"), LONDON, DEFAULT_HOURS)).toBe(false); // a Saturday
  });

  it("holds messages through quiet hours, and anything that can wait until work starts", () => {
    const lateMonday = at("2026-10-12T21:30:00Z");
    expect(deliverAt(lateMonday, LONDON, DEFAULT_HOURS, { urgent: true })).toEqual(at("2026-10-13T07:00:00Z")); // 08:00
    expect(deliverAt(lateMonday, LONDON, DEFAULT_HOURS, { urgent: false })).toEqual(at("2026-10-13T08:00:00Z")); // 09:00
    expect(deliverAt(at("2026-10-10T12:00:00Z"), LONDON, DEFAULT_HOURS, { urgent: false })).toEqual(at("2026-10-12T08:00:00Z"));
    const midday = at("2026-10-12T11:00:00Z");
    expect(deliverAt(midday, LONDON, DEFAULT_HOURS, { urgent: false })).toEqual(midday);
  });

  it("keeps WhatsApp's window open at the start or end of the day, not before it has to", () => {
    const hours = DEFAULT_HOURS;
    const timezone = LONDON;
    const lastIn = at("2026-10-12T09:30:00Z"); // Monday 10:30
    // End of Monday: only 7 hours quiet, and Tuesday's start comes before the window closes.
    expect(keepAliveDue(at("2026-10-12T16:30:00Z"), { lastIn, lastNudge: null, timezone, hours })).toBe(false);
    // Start of Tuesday: nearly a day quiet.
    expect(keepAliveDue(at("2026-10-13T08:15:00Z"), { lastIn, lastNudge: null, timezone, hours })).toBe(true);
    // Not mid-morning, not after a nudge they haven't answered, not after the window closed.
    expect(keepAliveDue(at("2026-10-13T10:00:00Z"), { lastIn, lastNudge: null, timezone, hours })).toBe(false);
    expect(keepAliveDue(at("2026-10-13T08:15:00Z"), { lastIn, lastNudge: at("2026-10-12T16:30:00Z"), timezone, hours })).toBe(false);
    expect(keepAliveDue(at("2026-10-13T10:30:00Z"), { lastIn: at("2026-10-12T08:00:00Z"), lastNudge: null, timezone, hours })).toBe(false);
    // Written before work on Monday: Tuesday's start would be too late, so the end of Monday is the moment.
    expect(keepAliveDue(at("2026-10-12T16:30:00Z"), { lastIn: at("2026-10-12T07:30:00Z"), lastNudge: null, timezone, hours })).toBe(true);
    // Written late on Friday: no working day starts or ends before it closes on Saturday evening (20:30),
    // so it goes in the last three hours outside quiet hours, not in the middle of the night.
    const friday = { lastIn: at("2026-10-16T19:30:00Z"), lastNudge: null, timezone, hours };
    expect(keepAliveDue(at("2026-10-16T22:00:00Z"), friday)).toBe(false); // 23:00, quiet
    expect(keepAliveDue(at("2026-10-17T12:00:00Z"), friday)).toBe(false); // 13:00 Saturday, too early
    expect(keepAliveDue(at("2026-10-17T16:30:00Z"), friday)).toBe(true); // 17:30 Saturday
    expect(keepAliveDue(at("2026-10-17T19:30:00Z"), friday)).toBe(false); // closed
    // Friday afternoon: the next working morning is Monday, so before the weekend.
    expect(keepAliveDue(at("2026-10-16T16:30:00Z"), { lastIn: at("2026-10-16T12:00:00Z"), lastNudge: null, timezone, hours })).toBe(true);
  });

  it("cleans what it's given and says it in a line", () => {
    expect(validHours({ days: [5, 1, 9, 1], start: "9:30", end: "25:00" })).toEqual({ ...DEFAULT_HOURS, days: [1, 5], start: "09:30" });
    expect(describeHours(DEFAULT_HOURS, LONDON)).toBe("Mon–Fri 09:00–18:00, quiet 21:00–08:00 (Europe/London)");
  });
});
