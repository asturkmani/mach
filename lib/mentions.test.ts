import { describe, expect, it } from "vitest";

import { findMentions, linkMentions } from "./mentions";

const people = [
  { id: "p1", name: "Karam" },
  { id: "p2", name: "Karam El Assaad" },
  { id: "a1", name: "Analyst" },
];

describe("mentions", () => {
  it("finds the longest name that matches, in order", () => {
    expect(findMentions("@analyst can you check with @Karam El Assaad?", people).map((p) => p.id)).toEqual(["a1", "p2"]);
    expect(findMentions("thanks @Karam.", people).map((p) => p.id)).toEqual(["p1"]);
    expect(findMentions("email karam@farmlend.co.uk", people)).toEqual([]);
    expect(findMentions("@Analysts", people)).toEqual([]);
  });

  it("links mentions for the thread without touching email addresses", () => {
    expect(linkMentions("@Karam El Assaad and @analyst, not karam@x.com", ["Karam", "Karam El Assaad", "Analyst"])).toBe(
      "[@Karam El Assaad](#mention) and [@analyst](#mention), not karam@x.com",
    );
  });
});
