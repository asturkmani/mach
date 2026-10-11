"use server";

import { revalidatePath } from "next/cache";

import { performAs } from "@/lib/actions";
import { OperationError } from "@/lib/operations";
import { actorOf, requireAppContext } from "@/lib/session";

// The Skills screen's actions. Each is an action in lib/actions/skills.ts, so
// the Chief of Staff does the same in chat.

export type SkillActionResult = { error?: string; message?: string };

async function perform(name: string, input: object): Promise<SkillActionResult> {
  try {
    const message = await performAs(actorOf(await requireAppContext()), name, input);
    revalidatePath("/skills");
    return { message };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
}

export async function saveSkillAction(_: SkillActionResult, form: FormData): Promise<SkillActionResult> {
  const field = (key: string) => String(form.get(key) ?? "").trim();
  return perform("skill.save", {
    name: field("name"),
    description: field("description"),
    body: field("body"),
    extends: field("extends") || undefined,
    shareWithCompany: form.get("share") === "on",
    note: field("note") || undefined,
  });
}

export async function restoreSkillAction(name: string, version: number): Promise<SkillActionResult> {
  return perform("skill.restore", { name, version });
}

export async function shareSkillAction(name: string, shareWithCompany: boolean): Promise<SkillActionResult> {
  return perform("skill.share", { name, shareWithCompany });
}

export async function archiveSkillAction(name: string): Promise<SkillActionResult> {
  return perform("skill.archive", { name });
}

export async function decideProposalAction(from: number, number: number, apply: boolean): Promise<SkillActionResult> {
  return perform(apply ? "skill.apply_proposal" : "skill.skip_proposal", { from, numbers: [number] });
}
