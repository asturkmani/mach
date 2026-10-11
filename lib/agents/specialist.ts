import "server-only";

import { stepCountIs, ToolLoopAgent, type LanguageModel } from "ai";

import type { AgentContext } from "@/lib/agents/prompts";
import { companyModel } from "@/lib/ai/company-model";
import { findSkillTool, knownSkills, pinnedSkills, SKILLS, toolsOf } from "@/lib/agents/skills";
import { companySkillsFor } from "@/lib/company-skills";
import { agentModel, builtinSkills, type Agent } from "@/lib/agents/store";
import { integrationTools, researchTools, sandboxTools, skillTool, type SandboxUser } from "@/lib/agents/toolkit";
import { listIntegrations } from "@/lib/integrations";
import type { CompanyModels } from "@/lib/orgs";
import { listSources } from "@/lib/research/store";
import { sourcesBrief } from "@/lib/research/sources";
import { exaTools } from "@/lib/research/tools";

// A quick question for one of the company's agents, answered while the
// Chief of Staff waits: the agent works on its own model (one chosen for its
// kind of work), with its instructions and the integrations it may use, in
// the sandbox of the person asking, for a few minutes at most. Anything
// longer becomes a task (the caller's job).

/** What a specialist says when the question needs real work: a task, not a chat answer. */
export const NEEDS_TASK = "NEEDS_TASK:";
const BUDGET_MS = 3 * 60_000;

let testModel: LanguageModel | null = null;
/** Tests swap in a scripted model. */
export function setSpecialistModel(model: LanguageModel | null): void {
  testModel = model;
}

export type SpecialistAnswer = { answer: string } | { needsTask: string };

export async function askSpecialist(
  workspace: AgentContext,
  using: SandboxUser,
  agent: Agent,
  company: CompanyModels,
  input: {
    question: string;
    askedBy: string;
    /** Their role and what they look after, so the answer fits them. */
    about?: string;
    profile: string;
    research?: boolean;
    /** Skills for this question (e.g. research), read before it starts. */
    skills?: string[];
  },
  { budgetMs = BUDGET_MS }: { budgetMs?: number } = {},
): Promise<SpecialistAnswer> {
  const catalogue = [...SKILLS, ...(await companySkillsFor(workspace.organizationId, workspace.personId))];
  const skills = knownSkills([...builtinSkills(agent), ...(input.skills ?? [])], catalogue);
  const model = testModel ?? agentModel(agent, company, skills, catalogue);
  if (!model) return { needsTask: `${agent.name} has no model set.` };
  const context: AgentContext = { ...workspace, agentId: agent.id, agentName: agent.name };
  const [integrations, sources] = await Promise.all([
    listIntegrations(workspace.organizationId, { personId: workspace.personId }),
    skills.some((s) => s === "coding-in-github" || s === "connecting-integrations") ? [] : listSources(workspace.organizationId, { viewer: workspace.personId }),
  ]);
  const allowed = {
    sources: integrations.filter((i) => i.kind === "api").map((i) => i.slug),
    logins: integrations.filter((i) => i.kind === "login").map((i) => i.slug),
  };
  const specialist = new ToolLoopAgent({
    model: companyModel(workspace.organizationId, model),
    instructions: `You are ${agent.name}${agent.role ? `, ${agent.role}` : ""}, one of the company's agents.${agent.description ? `\n\nYour job: ${agent.description}` : ""}${
      agent.instructions ? `\n\nYour instructions:\n${agent.instructions}` : ""
    }

The Chief of Staff is asking you a question for ${input.askedBy}${input.about ? ` (${input.about})` : ""}, and is waiting for your answer. Answer it directly and completely, with the figures, sources and reasoning that matter, in a few short paragraphs at most. You have a few minutes: use your tools if you need to (the company's data sources, research, code in a sandbox), but don't start anything long.

If answering properly needs longer work (a long analysis, files to produce, many steps, something to watch over time), don't start it: reply with exactly "${NEEDS_TASK} " and one line on what the work is. It will become a task for you.

Today's date: ${new Date().toISOString().slice(0, 10)}.

<company_profile>
${input.profile}
</company_profile>${sources.length ? `\n\n${sourcesBrief(sources, input.askedBy)}` : ""}${
      skills.length ? `\n\n<skills>\nFollow these skills (already loaded):\n\n${pinnedSkills(skills, catalogue)}\n</skills>` : ""
    }`,
    tools: {
      ...(input.research === false ? {} : researchTools(context)),
      ...(input.research === false || !toolsOf(skills, catalogue).includes("exa_search") ? {} : exaTools()),
      ...integrationTools(context, using, allowed),
      ...sandboxTools(context, using),
      use_skill: skillTool(catalogue),
      find_skill: findSkillTool(catalogue),
    },
    stopWhen: stepCountIs(20),
  });
  try {
    const result = await specialist.generate({ prompt: input.question, abortSignal: AbortSignal.timeout(budgetMs) });
    const text = result.text.trim();
    if (text.startsWith(NEEDS_TASK)) return { needsTask: text.slice(NEEDS_TASK.length).trim() || "It needs longer work." };
    return text ? { answer: text } : { needsTask: "It didn't come back with an answer." };
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      return { needsTask: `It needed more than ${Math.round(budgetMs / 60_000)} minutes.` };
    }
    throw error;
  }
}
