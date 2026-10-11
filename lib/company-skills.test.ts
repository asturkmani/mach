import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { workerAgent } from "@/lib/agents/store";
import { readFileSync } from "node:fs";

import { asSkill, getCompanySkill, integrationSkill, listCompanySkills, saveCompanySkill, saveIntegrationSkill } from "@/lib/company-skills";
import { getDb } from "@/lib/db";
import { saveIntegration } from "@/lib/integrations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask, getTaskByNumber } from "@/lib/tasks";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

async function team() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
  const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
  const as = (person: { id: string; name: string }, isAdmin = false) => ({
    organizationId: ORG,
    personId: person.id,
    name: person.name,
    userId: `user_${person.name.toLowerCase()}`,
    isAdmin,
  });
  return { sara, omar, asSara: as(sara), asOmar: as(omar), asAdmin: as(omar, true) };
}

const monthEnd = {
  name: "month-end-close",
  description: "Monthly: close the books for the family entities",
  body: "## Steps\n1. Pull the trial balance.\n2. Reconcile the banks.",
};

describe("company skills", () => {
  beforeEach(async () => {
    await useTestDb();
    setScheduler(() => {});
  });
  afterEach(() => {
    setScheduler(null);
    setSandboxProvider(null);
  });

  it("are saved from chat as their writer's, shared when asked, and only changed by their owner or an admin", async () => {
    const { sara, asSara, asOmar, asAdmin } = await team();
    expect(await doAction(asSara, "skill.save", monthEnd)).toMatch(/^Saved month-end-close \(version 1, yours only\)/);
    expect((await listCompanySkills(ORG, { viewer: sara.id })).map((s) => s.name)).toEqual(["month-end-close"]);
    // Private: Omar's agents don't see it, and he can't take its name.
    expect(await listCompanySkills(ORG, { viewer: asOmar.personId })).toEqual([]);
    expect(await doAction(asOmar, "skill.save", { ...monthEnd, body: "Mine" })).toBe("Not done: month-end-close is taken. Pick another name.");

    expect(await doAction(asSara, "skill.share", { name: "month-end-close", shareWithCompany: true })).toBe("month-end-close is the company's now.");
    expect((await getCompanySkill(ORG, "month-end-close", { viewer: asOmar.personId }))?.visibility).toBe("company");
    // Shared, it's still Sara's to change, or an admin's.
    expect(await doAction(asOmar, "skill.save", { ...monthEnd, body: "Changed" })).toBe("Not done: month-end-close is Sara's: they or an admin can change it.");
    expect(await doAction(asAdmin, "skill.save", { ...monthEnd, body: "## Steps\n1. Pull the trial balance first thing.", note: "Pull it first" })).toMatch(/version 2/);

    // Every version is kept; restoring makes an old one the newest.
    expect(await doAction(asSara, "skill.restore", { name: "month-end-close", version: 1 })).toBe("month-end-close is back to version 1's text, as version 3.");
    expect((await getCompanySkill(ORG, "month-end-close"))!.body).toBe(monthEnd.body);
    expect(await doAction(asSara, "skill.read", { name: "month-end-close" })).toContain("Versions: v3 (Restored version 1.); v2 (Pull it first); v1");
  });

  it("can be pinned from chat by the people who may use them; other names are refused", async () => {
    const { sara, asSara } = await team();
    await doAction(asSara, "skill.save", monthEnd);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const chat = async (skills: string[]) => {
      const model = scriptedModel([[["spawn_worker", { title: "Close September", brief: "Close the books for September.", why: "Month-end", skills }]], "On it."]);
      await createChiefOfStaff(
        {
          organization,
          user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" },
          person: (await getPerson(ORG, sara.id))!,
          profile: "",
          skills: (await listCompanySkills(ORG, { viewer: sara.id })).map(asSkill),
        },
        { model, research: false },
      ).generate({ prompt: "close september" });
      return JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
    };
    expect(await chat(["month-end-closing"])).toContain("Not started: There's no skill called month-end-closing. Look for it with find_skill.");
    expect(await chat(["month-end-close", "excel-models"])).toContain("Started task #1: Worker is on it, with month-end-close, excel-models.");
    expect((await getTaskByNumber(ORG, 1))!.skills).toEqual(["month-end-close", "excel-models"]);
  });

  it("can't take a Mach1 skill's name, and extend only Mach1's", async () => {
    const { asSara } = await team();
    expect(await doAction(asSara, "skill.save", { ...monthEnd, name: "research" })).toBe("Not done: research is one of Mach1's own skills. Write one that extends it instead.");
    expect(await doAction(asSara, "skill.save", { ...monthEnd, extends: "month-end" })).toBe("Not done: There's no Mach1 skill called month-end to extend.");
    expect(await doAction(asSara, "skill.save", { ...monthEnd, name: "Month End" })).toMatch(/^Not done: .*lowercase words joined by dashes/);
  });

  it("are pinned and loaded by the work done for the people who may see them, with their scripts in the sandbox", async () => {
    const { sara, omar } = await team();
    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    await saveCompanySkill(ORG, {
      name: "masttro-weekly-tagging",
      description: "Weekly: tag untagged Masttro transactions and route them for review",
      body: "Run pull_untagged.py, then classify.py.",
      scripts: { "pull_untagged.py": "print('pulled')" },
      ownerPersonId: sara.id,
      visibility: "private",
      by: { name: "Sara" },
    });
    await saveCompanySkill(ORG, {
      name: "our-decks",
      description: "Our deck template and colours",
      body: "Use the navy template.",
      extends: "presentations",
      by: { name: "Sara" },
    });
    const worker = await workerAgent(ORG);
    const task = await createTask(ORG, {
      title: "Tag this week's transactions",
      people: [sara.id],
      agents: [worker.id],
      skills: ["masttro-weekly-tagging"],
      createdBy: { personId: sara.id },
    });
    const model = scriptedModel([
      [["use_skill", { name: "presentations" }]],
      [["run_command", { command: "ls skills" }]],
      [["finish", { summary: "Tagged.", report: "Tagged." }]],
    ]);
    expect(await runAgentOnTask(ORG, task.id, worker.id, { model })).toEqual({ type: "finished" });
    const [first, second] = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(first).toContain("Run pull_untagged.py, then classify.py.");
    expect(first).toContain("masttro-weekly-tagging: Weekly: tag untagged Masttro transactions");
    // Loading Mach1's skill brings the company's way of it straight after.
    expect(second).toContain("Use the navy template.");
    expect(sandboxes.file(`mach-task-${task.id}`, "skills/masttro-weekly-tagging/pull_untagged.py")?.toString()).toBe("print('pulled')");

    // Work for Omar doesn't see Sara's private skill.
    const forOmar = await createTask(ORG, { title: "Something else", people: [omar.id], agents: [worker.id], createdBy: { personId: omar.id } });
    const omarModel = scriptedModel([[["finish", { summary: "Done.", report: "Done." }]]]);
    await runAgentOnTask(ORG, forOmar.id, worker.id, { model: omarModel });
    expect(JSON.stringify(omarModel.doGenerateCalls[0].prompt)).not.toContain("masttro-weekly-tagging");
    expect(JSON.stringify(omarModel.doGenerateCalls[0].prompt)).toContain("our-decks");
  });

  it("hold how each system works: one per integration, named after it, made from its guide", async () => {
    await team();
    const masttro = await saveIntegration(ORG, {
      kind: "api",
      name: "Masttro",
      slug: "masttro",
      config: { baseUrl: "https://api.masttro.example", domains: [], fields: [{ name: "key", label: "API key" }], headers: { "X-Key": "{{key}}" } },
      access: "read",
    });
    const first = await saveIntegrationSkill(ORG, masttro, { body: "GET /v1/positions pages by cursor.", note: "Set up from its docs.", by: { name: "Sara" } });
    expect(first).toMatchObject({ name: "masttro", kind: "integration", version: 1, ownerPersonId: null, visibility: "company" });
    expect(first.description).toBe("How Masttro works (data source). Load it before using masttro.");
    const second = await saveIntegrationSkill(ORG, masttro, { body: "GET /v1/positions pages by cursor; 100 a page.", note: "Paging", by: { name: "Learner" } });
    expect(second.version).toBe(2);
    expect((await integrationSkill(ORG, masttro.id))!.body).toContain("100 a page");

    // A workflow skill with the name already: the system's skill takes another.
    await saveCompanySkill(ORG, { name: "bloomberg", description: "Weekly Bloomberg pulls", body: "Steps", by: { name: "Sara" } });
    const bloomberg = await saveIntegration(ORG, { kind: "api", name: "Bloomberg", slug: "bloomberg", config: { baseUrl: "https://api.bloomberg.example", domains: [], fields: [] }, access: "read" });
    expect((await saveIntegrationSkill(ORG, bloomberg, { body: "How it works", note: "", by: { name: "Sara" } })).name).toBe("bloomberg-system");
  });

  it("start from each integration's guide in companies that had one", async () => {
    await team();
    const old = await saveIntegration(ORG, {
      kind: "login",
      name: "Masttro (web)",
      slug: "masttro-web",
      config: { loginUrl: "https://app.masttro.example/login", domains: [], fields: [] },
      access: "write",
      guide: "Tags are under Transactions → Untagged.",
    });
    const schema = readFileSync("db/schema.sql", "utf8");
    const migration = schema.slice(schema.indexOf("-- Each integration's guide becomes"));
    // Its two inserts, run as a deploy would; a second deploy changes nothing.
    const inserts = migration.slice(0, migration.indexOf("\n\n", 10)).split(";\n").map((sql) => sql.slice(sql.indexOf("insert")));
    for (let deploy = 0; deploy < 2; deploy++) for (const sql of inserts) await getDb().query(sql);
    const skill = (await integrationSkill(ORG, old.id))!;
    expect(skill).toMatchObject({ name: "masttro-web", kind: "integration", version: 1, body: "Tags are under Transactions → Untagged." });
    expect(skill.description).toBe("How Masttro (web) works (website login). Load it before using masttro-web.");
  });
});
