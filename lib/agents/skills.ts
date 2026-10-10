import { tool } from "ai";
import { z } from "zod";

import type { Role } from "@/lib/ai/lineup";
import { machSourceList } from "@/lib/mach-sources";

import base from "../skills.json";

// Skills are short playbooks an agent loads when a job calls for one. The
// system prompt lists each skill's name and description; the full text is only
// read (with use_skill) when it's needed, or when a task pins it, which keeps
// every prompt small. Mach1's base skills live in skills/<name>/SKILL.md and
// are collected into lib/skills.json on every build (scripts/skills.mjs).

export type Skill = {
  name: string;
  description: string;
  body: string;
  /** Tools the skill switches on while it's loaded (e.g. exa_search). */
  tools?: string[];
  /** The model role work with this skill runs on, unless the task or company says otherwise. */
  model?: Role;
};

/** Parts of a skill's text filled in when it's read, from the app's own data. */
const fill = (body: string) => body.replaceAll("{{mach_sources}}", machSourceList());

export const SKILLS: Skill[] = (base as Skill[]).map((s) => ({ ...s, body: fill(s.body) }));

const byName = new Map(SKILLS.map((s) => [s.name, s]));

export const getSkill = (name: string): Skill | undefined => byName.get(name);

/** Only the names of skills that exist, in order, once each. */
export const knownSkills = (names: readonly string[] = []): string[] => [...new Set(names.filter((n) => byName.has(n)))];

/** Every tool some skill switches on: they're off for an agent until one of its skills is loaded. */
export const SKILL_TOOLS: ReadonlySet<string> = new Set(SKILLS.flatMap((s) => s.tools ?? []));

/** The tools the given skills switch on. */
export const toolsOf = (names: readonly string[]): string[] => [...new Set(names.flatMap((n) => byName.get(n)?.tools ?? []))];

/** The model role of the first of these skills that names one. */
export const modelOf = (names: readonly string[]): Role | undefined => names.map((n) => byName.get(n)?.model).find(Boolean);

export function skillList(skills: Skill[] = SKILLS): string {
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** The full text of skills pinned to a task, for its brief: already loaded, so the agent doesn't load them again. */
export function pinnedSkills(names: readonly string[]): string {
  return knownSkills(names)
    .map((n) => `<skill name="${n}">\n${byName.get(n)!.body}\n</skill>`)
    .join("\n\n");
}

/** use_skill: reads a skill's playbook. onLoad hears which one, so the runtime can switch on its tools. */
export function skillTool(skills: Skill[] = SKILLS, onLoad?: (name: string) => void) {
  const names = skills.map((s) => s.name) as [string, ...string[]];
  return tool({
    description: "Load a skill: a short playbook for a kind of work. Use it before doing that kind of work.",
    inputSchema: z.object({ name: z.enum(names) }),
    execute: async ({ name }) => {
      onLoad?.(name);
      return skills.find((s) => s.name === name)!.body;
    },
  });
}
