import { describe, expect, it } from "vitest";

import { arrivals, type InboxItem } from "./inbox-arrivals";

const item = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id,
  number: 1,
  title: "Forecast Samsung earnings",
  summary: "Q3 estimate: KRW 109tn operating profit. Share it?",
  status: "review",
  updatedAt: "2026-10-07T16:20:00.000Z",
  ...patch,
});

describe("inbox arrivals", () => {
  it("notifies about new items and items that came back with something new, not about edits", () => {
    const before = new Map([["a", item("a")], ["b", item("b")]]);
    expect(
      arrivals(before, [
        item("a"),
        item("b", { updatedAt: "2026-10-07T16:25:00.000Z" }),
        item("c"),
      ]).map((i) => i.id),
    ).toEqual(["c"]);
    expect(
      arrivals(before, [item("a", { updatedAt: "2026-10-07T17:00:00.000Z", status: "waiting", summary: "Which quarter?" })]).map((i) => i.id),
    ).toEqual(["a"]);
  });
});
