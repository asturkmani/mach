"use server";

import { revalidatePath } from "next/cache";

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
