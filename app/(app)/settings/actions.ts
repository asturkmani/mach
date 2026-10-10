"use server";

import { revalidatePath } from "next/cache";

import { performAs } from "@/lib/actions";
import type { WorkHours } from "@/lib/assistant/hours";
import { OperationError } from "@/lib/operations";
import { actorOf, requireAppContext } from "@/lib/session";

// Your own settings (Settings → Account), declared in lib/actions/company.ts.

async function perform(name: string, input: object): Promise<{ error?: string }> {
  try {
    await performAs(actorOf(await requireAppContext()), name, input);
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings/account");
  return {};
}

/** Forgets your GitHub here and revokes what you granted Mach1 there. */
export async function disconnectGitHubAction(): Promise<void> {
  await perform("me.disconnect_github", {});
}

/** Rewrites what your assistant knows about you (only it reads this, and only while talking with you). */
export async function savePersonalNotesAction(notes: string): Promise<{ error?: string }> {
  return perform("me.set_notes", { notes });
}

/** When your assistant may message you first: your timezone, working hours and quiet hours. */
export async function saveWorkHoursAction(timezone: string, hours: WorkHours): Promise<{ error?: string }> {
  return perform("me.set_hours", { timezone, ...hours });
}
