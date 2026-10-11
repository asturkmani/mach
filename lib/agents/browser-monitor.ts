import "server-only";

import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import { companyModel } from "@/lib/ai/company-model";
import { roleModel } from "@/lib/ai/lineup";
import { approvalLabel, approvalsFor, type Approval } from "@/lib/approvals";
import type { AgentContext } from "@/lib/agents/prompts";

// The browser can't be checked by code alone: a click is just a click. When
// the browser agent works under an approval, each step it takes is first
// checked against the approved content by a separate model call that doesn't
// share the agent's goal (docs/agent-design.md, Gates in code), and a step
// outside it is refused.

let testModel: LanguageModel | null = null;
/** Tests swap in a scripted monitor. */
export function setBrowserMonitorModel(model: LanguageModel | null): void {
  testModel = model;
}

export type Approved = { label: string; what: string; items: string[]; file: string | null };

/** The approval a browser job works under, if it's approved. */
export async function approvedFor(context: AgentContext, ref: string | number | undefined): Promise<Approved | null> {
  "use step";
  if (!context.taskId || ref === undefined || ref === "") return null;
  const number = String(ref).replace(/^A/i, "");
  const approval: Approval | undefined = (await approvalsFor(context.organizationId, context.taskId)).find(
    (a) => String(a.number) === number && a.kind === "writes" && a.status === "approved",
  );
  return approval ? { label: approvalLabel(approval), what: approval.what, items: approval.items, file: approval.fileName } : null;
}

/** Whether the browser agent's next step stays within what was approved: reading and moving around always do. */
export async function checkBrowserStep(context: AgentContext, approved: Approved, step: string): Promise<{ allowed: boolean; reason: string }> {
  "use step";
  const { output } = await generateText({
    model: testModel ?? companyModel(context.organizationId, roleModel("background")),
    system: `You check one step a browser agent is about to take on a company's website, before it runs. You don't help it get its job done: you only check the step against what a person approved.
Allow it if it only reads or moves around (looking, scrolling, opening a page or a menu, searching, signing in), or if every change it makes (typing into a field that's saved, choosing an option, clicking save, submit, tag, delete, pay or send) is one of the approved changes, with the same values.
Refuse it if it changes anything that isn't in the approved list, uses different values, or you can't tell.`,
    prompt: `Approved (${approved.label}): ${approved.what}
${approved.items.length ? approved.items.map((item, i) => `${i + 1}. ${item}`).join("\n") : `The changes in the file ${approved.file}.`}

The next step:
${step}`,
    output: Output.object({ schema: z.object({ allowed: z.boolean(), reason: z.string().describe("One line.") }) }),
  });
  return output;
}
