import { describe, expect, it } from "vitest";

import { parseSource, SourceError, sourcesBrief } from "./sources";

describe("reading a source the way people give it", () => {
  it("takes links, handles and prefixes", () => {
    expect(parseSource("https://x.com/DeItaone")).toEqual({ kind: "x_account", handle: "DeItaone" });
    expect(parseSource("twitter.com/unusual_whales/status/1845")).toEqual({ kind: "x_account", handle: "unusual_whales" });
    expect(parseSource("@DeItaone")).toEqual({ kind: "x_account", handle: "DeItaone" });
    expect(parseSource("https://www.reddit.com/r/SecurityAnalysis/")).toEqual({ kind: "subreddit", handle: "SecurityAnalysis" });
    expect(parseSource("old.reddit.com/user/some_investor")).toEqual({ kind: "reddit_user", handle: "some_investor" });
    expect(parseSource("r/investing")).toEqual({ kind: "subreddit", handle: "investing" });
    expect(parseSource("/u/some_investor")).toEqual({ kind: "reddit_user", handle: "some_investor" });
    expect(parseSource("https://www.FT.com/markets?x=1")).toEqual({ kind: "website", handle: "ft.com" });
    expect(parseSource("semianalysis.substack.com")).toEqual({ kind: "website", handle: "semianalysis.substack.com" });
  });

  it("needs the kind for a bare name, and refuses what isn't a source", () => {
    expect(parseSource("investing", "subreddit")).toEqual({ kind: "subreddit", handle: "investing" });
    expect(parseSource("DeItaone", "x_account")).toEqual({ kind: "x_account", handle: "DeItaone" });
    expect(() => parseSource("investing")).toThrow(/@investing, r\/investing or u\/investing/);
    expect(() => parseSource("@not a handle")).toThrow(SourceError);
    expect(() => parseSource("@this_handle_is_far_too_long")).toThrow("isn't an X account");
    expect(() => parseSource("  ")).toThrow(SourceError);
  });
});

describe("the sources in a researcher's instructions", () => {
  it("groups them by kind with their notes, and says how to use them", () => {
    const brief = sourcesBrief(
      [
        { kind: "x_account", handle: "DeItaone", note: "breaking macro", visibility: "private" },
        { kind: "website", handle: "ft.com", note: "", visibility: "company" },
        { kind: "subreddit", handle: "investing", note: "retail mood", visibility: "private" },
      ],
      "Sara",
    );
    expect(brief).toContain("The sources Sara trusts most");
    expect(brief).toContain("Websites:\n- ft.com (the company's)");
    expect(brief).toContain("X accounts:\n- @DeItaone: breaking macro");
    expect(brief).toContain("Subreddits:\n- r/investing: retail mood");
    expect(brief).toContain("saved_only");
    expect(sourcesBrief([], "Sara")).toBe("");
  });
});
