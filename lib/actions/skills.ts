import "server-only";

import { z } from "zod";

import { defineAction } from "@/lib/actions/define";
import { SKILLS } from "@/lib/agents/skills";
import { appUrl } from "@/lib/app-url";
import { listCompanySkills, listSkillVersions } from "@/lib/company-skills";
import { archiveSkillAs, restoreSkillAs, saveSkillAs, shareSkillAs, skillFor } from "@/lib/operations";

// What the Skills screen does: the company's own skills (how it does its work
// and how its systems work), next to Mach1's. Agents load them for the work;
// people write them, or apply what the learner proposes. Who may change which
// is in lib/operations.ts.

const skillRef = z.string().min(1).describe("The skill's name, e.g. masttro-weekly-tagging.");

export const skillActions = [
  defineAction({
    name: "skill.save",
    description:
      "Save how a piece of work is done as a skill agents load for it (\"here's how we do month-end, save it\"), or change one you may change. Load the writing-skills skill first. New skills are yours unless shared.",
    input: z.object({
      name: skillRef,
      description: z.string().min(1).max(300).describe("One line saying when to use it, e.g. 'Weekly: tag untagged Masttro transactions and route them for review'."),
      body: z.string().min(1).max(40_000).describe("The skill: when to use it, steps, rules, pitfalls, checks."),
      extends: z.string().optional().describe("A Mach1 skill it adds the company's way to, e.g. presentations."),
      shareWithCompany: z.boolean().optional().describe("Everyone's agents use it. Otherwise only work for you does."),
      note: z.string().max(200).optional().describe("Why, in a line."),
    }),
    run: async ({ actor }, input) => {
      const saved = await saveSkillAs(actor, input);
      return `Saved ${saved.name} (version ${saved.version}${saved.visibility === "private" ? ", yours only" : ", the company's"}). ${appUrl(`/skills#${saved.name}`)}`;
    },
  }),
  defineAction({
    name: "skill.read",
    description: "Read one of the company's skills in full, with its versions, or one of Mach1's.",
    input: z.object({ name: skillRef }),
    run: async ({ actor }, { name }) => {
      const base = SKILLS.find((s) => s.name === name.trim());
      if (base) return `${base.name} (Mach1's): ${base.description}\n\n${base.body}`;
      const skill = await skillFor(actor, name);
      const versions = await listSkillVersions(skill.id);
      return [
        `${skill.name} (${skill.ownerName ? `${skill.ownerName}'s` : "the company's"}${skill.visibility === "company" && skill.ownerName ? ", shared" : ""}, version ${skill.version}): ${skill.description}`,
        skill.extends ? `Extends ${skill.extends}.` : "",
        skill.body,
        Object.keys(skill.scripts).length ? `Scripts: ${Object.keys(skill.scripts).join(", ")}` : "",
        `Versions: ${versions.map((v) => `v${v.version}${v.note ? ` (${v.note})` : ""}`).join("; ")}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  }),
  defineAction({
    name: "skill.list",
    description: "List the company's skills you can see, and Mach1's.",
    input: z.object({}),
    run: async ({ actor }) => {
      const own = await listCompanySkills(actor.organizationId, { viewer: actor.personId });
      return [
        own.length ? `The company's:\n${own.map((s) => `- ${s.name}: ${s.description}${s.visibility === "private" ? " (yours only)" : ""}`).join("\n")}` : "The company has no skills of its own yet.",
        `Mach1's: ${SKILLS.map((s) => s.name).join(", ")}.`,
        appUrl("/skills"),
      ].join("\n\n");
    },
  }),
  defineAction({
    name: "skill.restore",
    description: "Go back to an earlier version of a skill. The one it replaces stays restorable.",
    input: z.object({ name: skillRef, version: z.number().int().positive() }),
    run: async ({ actor }, { name, version }) => {
      const skill = await restoreSkillAs(actor, name, version);
      return `${skill.name} is back to version ${version}'s text, as version ${skill.version}.`;
    },
  }),
  defineAction({
    name: "skill.share",
    description: "Share one of your skills with the company (everyone's agents use it), or make it yours only again.",
    input: z.object({ name: skillRef, shareWithCompany: z.boolean() }),
    run: async ({ actor }, { name, shareWithCompany }) => {
      await shareSkillAs(actor, name, shareWithCompany);
      return shareWithCompany ? `${name} is the company's now.` : `${name} is yours only now.`;
    },
  }),
  defineAction({
    name: "skill.archive",
    description: "Retire a skill: agents stop using it. Its versions are kept.",
    input: z.object({ name: skillRef }),
    run: async ({ actor }, { name }) => {
      await archiveSkillAs(actor, name);
      return `Retired ${name}.`;
    },
  }),
];
