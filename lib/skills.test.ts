import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { getSkill, modelOf, pinnedSkills, SKILL_TOOLS, SKILLS, toolsOf } from "@/lib/agents/skills";

describe("base skills", () => {
  it("are up to date with skills/*/SKILL.md, and each one is well formed", () => {
    const run = spawnSync(process.execPath, ["scripts/skills.mjs", "--check"], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fill in the app's own data when read", () => {
    const pages = getSkill("building-pages")!;
    expect(pages.body).not.toContain("{{");
    expect(pages.body).toContain("mach:tasks");
  });

  it("say which tools they switch on and which model their work runs on", () => {
    expect(toolsOf(["research"])).toEqual(["exa_search"]);
    expect(modelOf(["coordinating"])).toBe("planner");
    expect(SKILL_TOOLS.has("exa_search")).toBe(true);
    expect(modelOf(["presentations", "coding-in-github"])).toBe("coder");
    expect(modelOf(["presentations"])).toBeUndefined();
  });

  it("put pinned skills' full text in a brief, skipping names that don't exist", () => {
    const text = pinnedSkills(["presentations", "no-such-skill"]);
    expect(text).toContain('<skill name="presentations">');
    expect(text).not.toContain("no-such-skill");
    expect(SKILLS.length).toBeGreaterThanOrEqual(13);
  });
});
