import { tool } from "ai";
import { z } from "zod";

import type { Role } from "@/lib/ai/lineup";
import { machSourceList } from "@/lib/mach-sources";

import base from "../skills.json";

// Skills are short playbooks an agent loads when a job calls for one. The
// system prompt lists each skill's name and description; the full text is only
// read (with use_skill) when it's needed, or when a task pins it, which keeps
// every prompt small. Mach1's base skills live in skills/<name>/SKILL.md and
// are collected into lib/skills.json on every build (scripts/skills.mjs); a
// company's own skills live in Postgres (lib/company-skills.ts) and join them
// in a run's catalogue. Every function here takes the catalogue, which is the
// base skills unless a company's are added.

export type Skill = {
  name: string;
  description: string;
  body: string;
  /** Tools the skill switches on while it's loaded (e.g. exa_search). */
  tools?: string[];
  /** The model role work with this skill runs on, unless the task or company says otherwise. */
  model?: Role;
  /** A company skill that adds the company's own way to a base skill: it's read straight after it. */
  extends?: string;
  /** Narrow kinds of write this skill may make without asking each time (lib/agents/gates.ts), e.g. opening a pull request. */
  preApproved?: string[];
  /** A company skill's scripts, by path under its folder: copied into the sandbox when it's loaded. */
  scripts?: Record<string, string>;
  /** Set for a company's own skill. */
  company?: { kind: "workflow" | "integration"; version: number; owner: string | null };
};

/** Parts of a skill's text filled in when it's read, from the app's own data. */
const fill = (body: string) => body.replaceAll("{{mach_sources}}", machSourceList());

export const SKILLS: Skill[] = (base as Skill[]).map((s) => ({ ...s, body: fill(s.body) }));

/** Once a catalogue is longer than this, the prompt lists Mach1's skills only, and the rest are found with find_skill. */
export const LISTED_SKILLS = 40;

const find = (skills: readonly Skill[], name: string) => skills.find((s) => s.name === name);

export const getSkill = (name: string, skills: readonly Skill[] = SKILLS): Skill | undefined => find(skills, name);

/** Only the names of skills that exist, in order, once each. */
export const knownSkills = (names: readonly string[] = [], skills: readonly Skill[] = SKILLS): string[] => [
  ...new Set(names.filter((n) => find(skills, n))),
];

/** Every tool some skill switches on: they're off for an agent until one of its skills is loaded. */
export const SKILL_TOOLS: ReadonlySet<string> = new Set(SKILLS.flatMap((s) => s.tools ?? []));

/** The tools the given skills switch on, and those of the base skills they extend. */
export const toolsOf = (names: readonly string[], skills: readonly Skill[] = SKILLS): string[] => [
  ...new Set(
    names.flatMap((n) => {
      const skill = find(skills, n);
      return [...(skill?.tools ?? []), ...(skill?.extends ? (find(skills, skill.extends)?.tools ?? []) : [])].filter((t) => SKILL_TOOLS.has(t));
    }),
  ),
];

/** The model role of the first of these skills that names one. */
export const modelOf = (names: readonly string[], skills: readonly Skill[] = SKILLS): Role | undefined =>
  names.map((n) => find(skills, n)?.model).find(Boolean);

/** The catalogue as the prompt lists it: one line each, or Mach1's skills and a pointer to find_skill when it's long. */
export function skillList(skills: readonly Skill[] = SKILLS): string {
  const line = (s: Skill) => `- ${s.name}: ${s.description}${s.company ? ` (the company's${s.company.kind === "integration" ? ", how a system works" : ""})` : ""}`;
  const own = skills.filter((s) => s.company);
  if (skills.length <= LISTED_SKILLS) return skills.map(line).join("\n");
  return `${skills.filter((s) => !s.company).map(line).join("\n")}\n- …and ${own.length} of the company's own skills: find them with find_skill.`;
}

/** Where a skill's scripts are in a job's sandbox. */
export const scriptsDir = (name: string) => `/vercel/job/skills/${name}`;

/**
 * A skill's text as an agent reads it: a base skill followed by the company's
 * skills that extend it; a company skill that extends a base one after it;
 * and where its scripts are.
 */
export function readSkill(name: string, skills: readonly Skill[] = SKILLS): string | null {
  const skill = find(skills, name);
  if (!skill) return null;
  const parts: string[] = [];
  const add = (s: Skill) => {
    parts.push(s.company ? `<skill name="${s.name}" company="yes">\n${s.body}\n</skill>` : s.body);
    const scripts = Object.keys(s.scripts ?? {});
    if (scripts.length) parts.push(`Its scripts are in ${scriptsDir(s.name)}/ (copied in when your sandbox starts): ${scripts.join(", ")}.`);
  };
  if (skill.extends) {
    const parent = find(skills, skill.extends);
    if (parent) add(parent);
  }
  add(skill);
  if (!skill.company) for (const extender of skills.filter((s) => s.extends === name)) add(extender);
  return parts.join("\n\n");
}

/** The full text of skills pinned to a task, for its brief: already loaded, so the agent doesn't load them again. */
export function pinnedSkills(names: readonly string[], skills: readonly Skill[] = SKILLS): string {
  return knownSkills(names, skills)
    .map((n) => `<skill name="${n}">\n${readSkill(n, skills)}\n</skill>`)
    .join("\n\n");
}

/** The skills a skill brings with it: the base one it extends, or the company's that extend it. */
export const loadedWith = (name: string, skills: readonly Skill[] = SKILLS): string[] => {
  const skill = find(skills, name);
  if (!skill) return [];
  return [name, ...(skill.extends ? [skill.extends] : []), ...(skill.company ? [] : skills.filter((s) => s.extends === name).map((s) => s.name))];
};

/** use_skill: reads a skill's playbook. onLoad hears which skills that brought in, so the runtime can switch on their tools and copy their scripts. */
export function skillTool(skills: readonly Skill[] = SKILLS, onLoad?: (names: string[]) => void) {
  return tool({
    description: "Load a skill: a playbook for a kind of work, or for one of the company's systems or ways of working. Use it before doing that kind of work.",
    inputSchema: z.object({ name: z.string().min(1).describe("The skill's name, from the list in your instructions or from find_skill.") }),
    execute: async ({ name }) => {
      const text = readSkill(name.trim(), skills);
      if (text === null) return `There's no skill called ${name}. Look for it with find_skill, or use one from your list.`;
      onLoad?.(loadedWith(name.trim(), skills));
      return text;
    },
  });
}

/** find_skill: searches the catalogue by words in a skill's name and description. */
export function findSkillTool(skills: readonly Skill[] = SKILLS) {
  return tool({
    description: "Search the skills you can load, Mach1's and the company's own, by what the work is about (e.g. 'masttro tagging', 'month-end').",
    inputSchema: z.object({ words: z.string().min(1) }),
    execute: async ({ words }) => {
      const terms = words.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      const scored = skills
        .map((s) => {
          const text = `${s.name} ${s.description}`.toLowerCase();
          return { s, score: terms.filter((t) => text.includes(t)).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      if (!scored.length) return "No skill matches those words.";
      return scored.map(({ s }) => `- ${s.name}: ${s.description}${s.company ? " (the company's)" : ""}`).join("\n");
    },
  });
}
