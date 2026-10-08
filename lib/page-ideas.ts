import "server-only";

import { createHash } from "node:crypto";

import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { listDrive } from "@/lib/drive";
import { listIntegrations } from "@/lib/integrations";
import { listPages } from "@/lib/pages";
import { loadProfile } from "@/lib/profile/store";

// Ideas for the company's next pages, shown on the Pages screen so people see
// what's possible with their own data: written by a model from the company
// profile, its integrations (and whether each is connected) and the pages it
// already has. Kept until any of those change, so the screen stays fast.

export type PageIdea = {
  /** What the person reads, e.g. "Net worth by entity and asset class, every weekday at 7am". */
  title: string;
  /** What's sent to the Chief of Staff when they pick it. */
  prompt: string;
  /** Where the data comes from, e.g. "Masttro". */
  source: string;
  /** A system that has to be connected first, if any. */
  needsConnecting: string | null;
};

const schema = z.object({
  ideas: z
    .array(
      z.object({
        title: z.string().describe("The page, in a short line: what it shows and how often it refreshes, if it does."),
        prompt: z.string().describe("The request to the Chief of Staff, in the person's voice, starting 'Build me a page'."),
        source: z.string().describe("Where its data comes from: an integration's name, the drive file it reads, or Mach for its tasks, people and agents."),
        needsConnecting: z.string().nullable().describe("The system to connect first when it isn't a connected data source yet, else null."),
      }),
    )
    .max(4),
});

/** Everything the ideas depend on, as the model reads it. */
async function inputs(organizationId: string): Promise<string> {
  const [profile, integrations, pages, drive] = await Promise.all([
    loadProfile(organizationId),
    listIntegrations(organizationId),
    listPages(organizationId),
    listDrive(organizationId, { limit: 40 }),
  ]);
  const sources = integrations.map(
    (i) =>
      `- ${i.name} (${i.kind === "api" ? "data source, agents can read its API" : "website login only, for a browser; its API isn't connected"}, ${i.status.replace("_", " ")})${i.description ? `: ${i.description}` : ""}`,
  );
  return [
    `<company_profile>\n${profile.trim() || "(empty)"}\n</company_profile>`,
    `Integrations:\n${sources.join("\n") || "(none yet)"}`,
    `Files on the company drive (newest first):\n${drive.map((f) => `- ${f.path}`).join("\n") || "(none)"}`,
    `Pages they already have:\n${pages.map((p) => `- ${p.title}: ${p.description}`).join("\n") || "(none)"}`,
  ].join("\n\n");
}

const INSTRUCTIONS = `You suggest pages for a company that uses Mach. A page is a dashboard of the company's own data that the Chief of Staff builds and keeps fresh on a schedule: headline numbers, tables and charts, shown as a tab on Home.

Suggest up to four pages this company would open every day or week, specific to what it does and the systems it uses. Rules:
- A page can show data from the company's data sources (APIs), files on its company drive, and Mach's own data, read live: its tasks (status, priority, who's on them, dates), people and agents. Not chats or other documents. Prefer connected data sources and Mach's own data. A system named in the profile, or connected only as a website login, can be suggested too, with needsConnecting set to its name, since its API has to be connected first.
- Don't repeat a page they already have. Don't invent systems, numbers or names that aren't in what you're given.
- Titles are one short line in plain words, like "Net worth by entity and asset class, every weekday at 7am". Mach's own data is always live, so a page that only reads it has no schedule.
- If almost nothing is known about the company, suggest fewer, simpler pages.`;

/**
 * The company's page ideas: from the cache while its profile, integrations and
 * pages are unchanged, otherwise written afresh. Empty when no model is set up
 * or it fails; the screen then just says to ask the Chief of Staff.
 */
export async function pageIdeas(organizationId: string, options: { model?: LanguageModel } = {}): Promise<PageIdea[]> {
  const text = await inputs(organizationId);
  const sha256 = createHash("sha256").update(INSTRUCTIONS).update(text).digest("hex");
  const db = getDb();
  const [cached] = await db.query<{ inputs_sha256: string; ideas: PageIdea[] }>(
    "select inputs_sha256, ideas from page_ideas where organization_id = $1",
    [organizationId],
  );
  if (cached?.inputs_sha256 === sha256) return cached.ideas;

  const model = options.model ?? process.env.PAGE_IDEAS_MODEL ?? process.env.CHIEF_OF_STAFF_MODEL;
  if (!model) return [];
  let ideas: PageIdea[];
  try {
    const result = await generateText({ model, system: INSTRUCTIONS, prompt: text, output: Output.object({ schema }) });
    ideas = result.output.ideas.map((i) => ({ ...i, needsConnecting: i.needsConnecting?.trim() || null }));
  } catch (error) {
    console.error("Couldn't write page ideas", error);
    return cached?.ideas ?? [];
  }
  await db.query(
    `insert into page_ideas (organization_id, inputs_sha256, ideas) values ($1, $2, $3)
     on conflict (organization_id) do update set inputs_sha256 = excluded.inputs_sha256, ideas = excluded.ideas, created_at = now()`,
    [organizationId, sha256, JSON.stringify(ideas)],
  );
  return ideas;
}
