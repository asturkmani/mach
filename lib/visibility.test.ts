import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent } from "@/lib/agents/store";
import { MACH_SOURCES } from "@/lib/mach-data";
import { createOrganization } from "@/lib/orgs";
import { handOverShared, linkMember } from "@/lib/people";
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
import { callIntegration, listIntegrations, sandboxPolicy, saveCredentials, saveIntegration, updateIntegration } from "@/lib/integrations";
import { canReadVersion, findFiles, listLibrary, saveVersion, setFileVisibility } from "@/lib/files";
import { getPage, listPages, savePage, setPageVisibility } from "@/lib/pages";
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

  it("shows files to their owner and to whoever can see a task they're on, and pages to whoever made them, until shared", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    const by = { name: "Sara", personId: sara.id };

    // A file attached in Sara's chat is hers; one made on her private task is seen by whoever can see the task.
    const attached = await saveVersion(ORG, { name: "my-plan.pdf", kind: "deliverable", bytes: Buffer.from("plan"), personId: sara.id });
    const task = await createTaskWithTeam(ORG, { title: "Model my portfolio", by });
    const made = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("model"), taskId: task.id });
    const names = async (viewer: string) => (await listLibrary(ORG, { viewer })).map((f) => f.name).sort();
    expect(await names(sara.id)).toEqual(["model.xlsx", "my-plan.pdf"]);
    expect(await names(omar.id)).toEqual([]);
    expect(await canReadVersion(ORG, made.versionId, omar.id)).toBe(false);
    expect(await findFiles(ORG, ["my-plan.pdf"], { viewer: omar.id })).toEqual([]);

    // Sharing the task shares its files; sharing a file shares it on its own.
    await setTaskVisibility(ORG, task.id, "company");
    expect(await names(omar.id)).toEqual(["model.xlsx"]);
    await setFileVisibility(ORG, attached.fileId, "company");
    expect(await canReadVersion(ORG, attached.versionId, omar.id)).toBe(true);

    // A page Sara has the Chief of Staff build is hers until she shares it, with its refresh job.
    const { page } = await savePage(ORG, { title: "My net worth", html: "<h1>Net worth</h1>", data: ["mach:people"], by });
    expect(page.visibility).toBe("private");
    expect(await getPage(ORG, page.slug, { viewer: omar.id })).toBeNull();
    expect((await listPages(ORG, { viewer: omar.id })).map((p) => p.slug)).toEqual([]);
    // Omar's Chief of Staff can't overwrite it by its slug: it makes his own page instead.
    const { page: his } = await savePage(ORG, { slug: page.slug, title: "Mine", html: "<p>x</p>", data: [], by: { name: "Omar", personId: omar.id } });
    expect(his.slug).not.toBe(page.slug);
    await setPageVisibility(ORG, page.slug, "company");
    expect((await getPage(ORG, page.slug, { viewer: omar.id }))?.title).toBe("My net worth");
  });

  it("lets only chosen people's work use an integration", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    const masttro = await saveIntegration(ORG, {
      kind: "api",
      name: "Masttro",
      config: { baseUrl: "https://api.masttro.example", domains: [], fields: [{ name: "apiKey", label: "API key" }], headers: { Authorization: "Bearer {{apiKey}}" } },
    });
    await saveCredentials(ORG, masttro.id, { apiKey: "mst_live_key_123" });
    await updateIntegration(ORG, masttro.id, { personIds: [sara.id] });

    expect((await listIntegrations(ORG, { personId: sara.id })).map((i) => i.slug)).toEqual(["masttro"]);
    expect(await listIntegrations(ORG, { personId: omar.id })).toEqual([]);
    await expect(callIntegration(ORG, "masttro", { path: "/positions" }, { personId: omar.id })).rejects.toThrow(/don't have access/);
    // A sandbox working for Omar isn't connected to it; one working for Sara is.
    expect((await sandboxPolicy(ORG, null, {}, omar.id)).sources).toEqual([]);
    expect((await sandboxPolicy(ORG, null, {}, sara.id)).sources).toEqual(["masttro"]);
  });

  it("hands what someone shared to an admin when they leave, keeping their private things private", async () => {
    const admin = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    const by = { name: "Omar", personId: omar.id };
    const shared = await createTaskWithTeam(ORG, { title: "Family report", visibility: "company", by });
    const own = await createTaskWithTeam(ORG, { title: "Omar's notes", by });
    await handOverShared(ORG, omar.id, admin.id);
    expect((await getTaskByNumber(ORG, shared.number))?.createdByPersonId).toBe(admin.id);
    expect((await getTaskByNumber(ORG, own.number))?.createdByPersonId).toBe(omar.id);
    expect(await canSeeTask(ORG, own.id, admin.id)).toBe(false);
  });
});
