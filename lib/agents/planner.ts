import "server-only";

import { generateText, type LanguageModel } from "ai";

import type { Agent } from "@/lib/agents/store";
import { companyModel } from "@/lib/ai/company-model";
import { roleModel } from "@/lib/ai/lineup";
import type { LibraryFile } from "@/lib/files";
import type { Integration } from "@/lib/integrations";
import type { Task } from "@/lib/tasks";

// The coordinator: before a big job, the Chief of Staff asks the company's
// planner model (Opus, or Astra; lib/ai/lineup.ts) to think it through: what
// to ask first, the steps, who does each, and which wait for which. The
// Chief of Staff then asks the questions or creates the tasks, later steps
// starting by themselves as earlier ones are delivered.

let testModel: LanguageModel | null = null;
/** Tests swap in a scripted model. */
export function setPlannerModel(model: LanguageModel | null): void {
  testModel = model;
}

export type PlanInput = {
  request: string;
  askedBy: string;
  profile: string;
  agents: Pick<Agent, "name" | "role" | "description" | "kind" | "status">[];
  integrations: Pick<Integration, "name" | "kind">[];
  files: Pick<LibraryFile, "name">[];
  openTasks: Pick<Task, "number" | "title" | "status">[];
};

export async function planJob(organizationId: string, input: PlanInput): Promise<string> {
  const agents = input.agents.filter((a) => a.kind === "defined" && a.status === "active");
  const { text } = await generateText({
    model: companyModel(organizationId, testModel ?? roleModel("planner")),
    system: `You plan big jobs for ${input.askedBy}'s company before any work starts. The Chief of Staff turns your plan into tasks, each worked on by one agent (a defined agent, or a new worker agent with a role), and reports back to ${input.askedBy}. Agents can research the web, use the company's data sources and logins, run code and build files and spreadsheets in a sandbox, and browse websites.

Write the plan in exactly this shape, plainly, no other text:

Goal: one sentence.
Ask first: what must be settled with ${input.askedBy} before starting (choices only they can make, missing access or data), one per line starting "- ". Write "none" if the work can start.
Steps:
1. Title starting with a verb | who: an agent's exact name, or "new worker: <role>" | after: step numbers it needs first, or "none"
   What to do, the inputs (named files, data sources, earlier steps' results) and what done looks like, in two or three sentences.
Risks: one line, or "none".

Keep it to the fewest steps that do the job well (two to six). Steps that don't need each other run at the same time, so only make a step wait when it needs an earlier result. Prefer the company's agents when one fits. Use only data sources, files and agents listed below, or say in "Ask first" what's missing.

Today's date: ${new Date().toISOString().slice(0, 10)}.

<company_profile>
${input.profile}
</company_profile>

Agents: ${agents.map((a) => `${a.name}${a.role ? ` (${a.role})` : ""}${a.description ? `: ${a.description}` : ""}`).join("; ") || "none yet"}
Data sources and logins: ${input.integrations.map((i) => `${i.name} (${i.kind === "api" ? "data source" : "login"})`).join(", ") || "none"}
Files: ${input.files.map((f) => f.name).join(", ") || "none"}
Open tasks: ${input.openTasks.map((t) => `#${t.number} ${t.title} (${t.status})`).join("; ") || "none"}`,
    prompt: input.request,
  });
  return text.trim();
}
