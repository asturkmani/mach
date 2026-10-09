// The names and contents of Mach1's own data that pages can read live (the
// loaders are in lib/mach-data.ts). Plain text only, so agent prompts and
// skills can describe them without loading anything.

export const MACH_SOURCE_DESCRIPTIONS = {
  "mach:tasks":
    "The company's tasks: every open one and the latest 100 closed, each { number, title, status (backlog, ready, in_progress, waiting, review, done, cancelled), priority (urgent, high, medium, low), summary, people, agents, repeats, running, activity, laterUntil, createdAt, updatedAt, closedAt, url }. Archived tasks and profile suggestions are left out.",
  "mach:people":
    "The people in the company: { name, role, responsibilities, reportsTo, status (not_invited, invited, active: uses Mach1) }. No emails or phone numbers.",
  "mach:agents": "The company's agents: { name, role, kind (defined: a standing role; worker: made for one task), status, description }.",
} as const;

export type MachSource = keyof typeof MACH_SOURCE_DESCRIPTIONS;

export const isMachSource = (name: string): name is MachSource => Object.hasOwn(MACH_SOURCE_DESCRIPTIONS, name);

/** Each source and what's in it, one per line. */
export const machSourceList = () =>
  Object.entries(MACH_SOURCE_DESCRIPTIONS)
    .map(([name, description]) => `- ${name}: ${description}`)
    .join("\n");
