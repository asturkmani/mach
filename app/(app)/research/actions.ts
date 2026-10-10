"use server";

import { revalidatePath } from "next/cache";

import { performAs } from "@/lib/actions";
import { OperationError } from "@/lib/operations";
import { SOURCE_KINDS, type SourceKind } from "@/lib/research/sources";
import { actorOf, requireAppContext } from "@/lib/session";

// The Research screen's actions: the sources people trust most. Each is an
// action in lib/actions/research.ts, so the Chief of Staff does the same in chat.

export type SourceActionResult = { error?: string; message?: string };

async function perform(name: string, input: object): Promise<SourceActionResult> {
  try {
    const message = await performAs(actorOf(await requireAppContext()), name, input);
    revalidatePath("/research");
    return { message };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
}

export async function addSourceAction(_: SourceActionResult, form: FormData): Promise<SourceActionResult> {
  const field = (key: string) => String(form.get(key) ?? "").trim();
  const kind = SOURCE_KINDS.includes(field("kind") as SourceKind) ? (field("kind") as SourceKind) : undefined;
  return perform("source.add", { source: field("source"), kind, note: field("note"), shareWithCompany: form.get("share") === "on" });
}

export async function updateSourceAction(id: string, patch: { note?: string; shareWithCompany?: boolean }): Promise<SourceActionResult> {
  return perform("source.update", { source: id, ...patch });
}

export async function removeSourceAction(id: string): Promise<SourceActionResult> {
  return perform("source.remove", { source: id });
}
