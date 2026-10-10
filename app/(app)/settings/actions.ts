"use server";

import { revalidatePath } from "next/cache";

import { MEMORY_LIMIT, savePersonalMemory } from "@/lib/agents/conversation";
import type { WorkHours } from "@/lib/assistant/hours";
import { saveAssistantHours } from "@/lib/assistant/store";
import { disconnectGitHub } from "@/lib/github";
import { setAutoJoin } from "@/lib/orgs";
import { requireAppContext } from "@/lib/session";

/** Whether colleagues with the company's email domain join without asking (admins only). */
export async function setAutoJoinAction(on: boolean): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change who joins." };
  if (!organization.domain) return { error: "The company has no email domain." };
  await setAutoJoin(organization.id, on);
  revalidatePath("/settings");
  return {};
}

/** Forgets your GitHub here and revokes what you granted Mach1 there. */
export async function disconnectGitHubAction(): Promise<void> {
  const { organization, person } = await requireAppContext();
  await disconnectGitHub(organization.id, person.id);
  revalidatePath("/settings/account");
}

/** Rewrites what your assistant knows about you (only it reads this, and only while talking with you). */
export async function savePersonalNotesAction(notes: string): Promise<{ error?: string }> {
  const { organization, person } = await requireAppContext();
  if (notes.length > MEMORY_LIMIT) return { error: `Keep it under ${MEMORY_LIMIT} characters.` };
  await savePersonalMemory(organization.id, person.id, notes);
  revalidatePath("/settings/account");
  return {};
}

/** When your assistant may message you first: your timezone, working hours and quiet hours. */
export async function saveWorkHoursAction(timezone: string, hours: WorkHours): Promise<{ error?: string }> {
  const { organization, person } = await requireAppContext();
  try {
    await saveAssistantHours(organization.id, person.id, timezone.trim(), hours);
  } catch (error) {
    return { error: (error as Error).message };
  }
  revalidatePath("/settings/account");
  return {};
}
