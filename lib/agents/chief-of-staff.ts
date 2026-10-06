import "server-only";

import { ToolLoopAgent, tool, type InferAgentUIMessage, type LanguageModel } from "ai";
import { z } from "zod";

import {
  PEOPLE_SECTION,
  SECTIONS,
  removePerson,
  setCompanyName,
  setSection,
  upsertPerson,
} from "@/lib/profile/markdown";
import { loadProfile, saveProfile } from "@/lib/profile/store";

function instructions(profile: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the Chief of Staff of a company that has just started using Mach, a command center where people and AI agents run the business together. Right now your job is onboarding: interview the person you are talking to and build the company profile.

The company profile is a markdown document. Its current content is below. It is the only thing you remember between conversations, so record facts in it as soon as you learn them.

How to run the interview:
- Start by introducing yourself in one or two sentences, then ask for the company's name and what it does.
- Ask one or two questions at a time, in plain language. Keep your messages short.
- Cover, roughly in this order: what the company does and for whom; the people (name, role, who they report to, what they're responsible for, how to reach them); mission, vision and values; current goals; products and services; customers; how the team likes to work; internal jargon.
- Reporting lines matter most. For every person, make sure you know who they report to. The founder or CEO usually reports to no one. If someone mentions a person who isn't listed yet, ask about them.
- Record what you learn immediately with your tools, then continue the conversation. Don't ask permission to save.
- Write sections in the company's own words, concise and factual. Never invent facts; if something is unclear, ask.
- If the person wants to skip a section, write "_Skipped for now._" in it and move on.
- When every section has content or was skipped, give a short summary of the organisation and its reporting lines, and say they can keep telling you changes at any time.

Tool rules:
- Use set_company_name for the company's name.
- Use upsert_person / remove_person for people. Never write the "${PEOPLE_SECTION}" section with update_section; the people table and reporting lines are generated from upsert_person.
- Use update_section for every other section. Pass the complete new body of the section (markdown, no "## " heading); it replaces what was there, so carry over anything that should stay.

Sections: ${SECTIONS.join(", ")}.

Today's date: ${today}.

<company_profile>
${profile}
</company_profile>`;
}

// Each tool reads the latest profile, applies one change and saves it, then
// returns the whole document so the model and the UI both see the new state.
// The model often calls several tools in parallel, so changes are queued to
// stop one read-modify-write from overwriting another.
let pending: Promise<unknown> = Promise.resolve();

function applyChange(change: (markdown: string) => string): Promise<{ profile: string }> {
  const run = pending.then(async () => {
    const updated = change(await loadProfile());
    await saveProfile(updated);
    return { profile: updated };
  });
  pending = run.catch(() => undefined);
  return run;
}

const sectionNames = SECTIONS.filter((s) => s !== PEOPLE_SECTION) as [string, ...string[]];

export const chiefOfStaffTools = {
  set_company_name: tool({
    description: "Set the company's name (the profile's title).",
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async ({ name }) => applyChange((md) => setCompanyName(md, name)),
  }),
  update_section: tool({
    description:
      "Replace the body of one profile section with new markdown. Pass the full section body, not a diff. Not for the people section.",
    inputSchema: z.object({
      section: z.enum(sectionNames),
      content: z.string().describe("Full markdown body for the section, without the '## ' heading."),
    }),
    execute: async ({ section, content }) => applyChange((md) => setSection(md, section, content)),
  }),
  upsert_person: tool({
    description:
      "Add a person to the organisation or update their details. Only the fields you pass are changed. reportsTo is the exact name of their manager; use an empty string for someone who reports to no one.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Full name, used as the person's identifier."),
      role: z.string().optional().describe("Job title or role."),
      reportsTo: z.string().optional().describe("Exact name of the person they report to, or empty."),
      responsibilities: z.string().optional().describe("What they own, in a short phrase."),
      contact: z.string().optional().describe("Email or phone, if given."),
    }),
    execute: async (person) => applyChange((md) => upsertPerson(md, person)),
  }),
  remove_person: tool({
    description: "Remove a person from the organisation. Anyone who reported to them is left without a manager.",
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async ({ name }) => applyChange((md) => removePerson(md, name)),
  }),
};

export function createChiefOfStaff(profile: string, model: LanguageModel | undefined = process.env.CHIEF_OF_STAFF_MODEL) {
  if (!model) {
    throw new Error("Set CHIEF_OF_STAFF_MODEL to an AI Gateway model id (see README).");
  }
  return new ToolLoopAgent({
    model,
    instructions: instructions(profile),
    tools: chiefOfStaffTools,
  });
}

export type ChiefOfStaffMessage = InferAgentUIMessage<ReturnType<typeof createChiefOfStaff>>;
