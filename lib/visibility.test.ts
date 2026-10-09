import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent } from "@/lib/agents/store";
import { MACH_SOURCES } from "@/lib/mach-data";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import {
  addMention,
  canSeeTask,
  findTasks,
  getTaskByNumber,
  listAgentTasks,
  listTasks,
  listWorking,
  searchTasks,
  setTaskVisibility,
} from "@/lib/tasks";
import { createTaskWithTeam } from "@/lib/work";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";

describe("private and company work", () => {
  beforeEach(async () => {
    await useTestDb();
    setScheduler(() => {});
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("keeps work someone asks for to them and the people on it, until it's shared", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    const lina = await linkMember(ORG, { id: "user_lina", email: "lina@cedar.example", name: "Lina" });
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const by = { name: "Sara", personId: sara.id };

    const mine = await createTaskWithTeam(ORG, { title: "Model my own portfolio", agentIds: [analyst.id], by });
    const withOmar = await createTaskWithTeam(ORG, { title: "Draft the board memo", personIds: [omar.id], by });
    const everyone = await createTaskWithTeam(ORG, { title: "Weekly family report", visibility: "company", by });
    expect([mine.visibility, withOmar.visibility, everyone.visibility]).toEqual(["private", "private", "company"]);

    const titles = async (viewer: string) => (await listTasks(ORG, { viewer })).map((t) => t.title).sort();
    expect(await titles(sara.id)).toEqual(["Draft the board memo", "Model my own portfolio", "Weekly family report"]);
    expect(await titles(omar.id)).toEqual(["Draft the board memo", "Weekly family report"]);
    expect(await titles(lina.id)).toEqual(["Weekly family report"]);
    // Internal work (runs, schedules) sees everything.
    expect(await listTasks(ORG)).toHaveLength(3);

    // Every way of finding a task follows the same rule.
    expect(await getTaskByNumber(ORG, mine.number, { viewer: lina.id })).toBeNull();
    expect(await canSeeTask(ORG, mine.id, lina.id)).toBe(false);
    expect((await findTasks(ORG, { query: "portfolio", viewer: lina.id })).length).toBe(0);
    expect((await searchTasks(ORG, "portfolio", 10, { viewer: lina.id })).length).toBe(0);
    expect((await listAgentTasks(ORG, analyst.id, { viewer: lina.id })).length).toBe(0);
    expect((await listAgentTasks(ORG, analyst.id, { viewer: sara.id })).length).toBe(1);
    expect(await listWorking(ORG, { viewer: lina.id })).toEqual([]);

    // Mentioning Lina lets her see it; sharing it shows it to everyone; making it private again hides it.
    await addMention(withOmar.id, lina.id, "Sara");
    expect(await canSeeTask(ORG, withOmar.id, lina.id)).toBe(true);
    await setTaskVisibility(ORG, mine.id, "company");
    expect(await canSeeTask(ORG, mine.id, lina.id)).toBe(true);
    await setTaskVisibility(ORG, mine.id, "private");
    expect(await canSeeTask(ORG, mine.id, lina.id)).toBe(false);

    // Pages read the company's tasks only, since a page can be shared with everyone.
    const onPages = (await MACH_SOURCES["mach:tasks"].load(ORG)) as { title: string }[];
    expect(onPages.map((t) => t.title)).toEqual(["Weekly family report"]);
  });
});
