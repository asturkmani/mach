import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { appMapLines, SCREENS } from "./app-map";

describe("the app map", () => {
  it("is up to date with every page, and every page says what it is", () => {
    const run = spawnSync(process.execPath, ["scripts/app-map.mjs", "--check"], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("gives the Chief of Staff full links to each screen", () => {
    expect(SCREENS.map((s) => s.path)).toEqual(expect.arrayContaining(["/", "/team", "/settings/ai", "/tasks/{number}"]));
    expect(appMapLines()).toMatch(/- Team: https?:\/\/[^ ]+\/team \(Left menu → Team\)/);
  });
});
