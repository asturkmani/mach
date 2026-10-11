"use server";

import { revalidatePath } from "next/cache";

import { AiKeyError, removeAiKey, saveAiKey } from "@/lib/ai/keys";
import { OperationError, setCompanyModelsAs, setJobCostLimitAs } from "@/lib/operations";
import type { CompanyModels } from "@/lib/orgs";
import { actorOf, requireAppContext } from "@/lib/session";

/** Adds or replaces the company's key for a provider, once the provider accepts it (admins only). */
export async function saveAiKeyAction(provider: string, apiKey: string): Promise<{ error?: string; testedOn?: string }> {
  const { organization, person, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change the company's AI keys." };
  let testedOn: string;
  try {
    ({ testedOn } = await saveAiKey(organization.id, provider, apiKey, person.id));
  } catch (error) {
    if (error instanceof AiKeyError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings/ai");
  return { testedOn };
}

export async function removeAiKeyAction(provider: string): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change the company's AI keys." };
  await removeAiKey(organization.id, provider);
  revalidatePath("/settings/ai");
  return {};
}

/** The company's own default models for its Chief of Staff and agents (admins only); empty uses Mach1's. */
export async function saveCompanyModelsAction(models: CompanyModels): Promise<{ error?: string }> {
  try {
    await setCompanyModelsAs(actorOf(await requireAppContext()), models);
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings/ai");
  return {};
}

/** The dollars a job may be estimated at before its plan needs a person's approval (admins only); null for no limit. */
export async function saveJobCostLimitAction(limit: number | null): Promise<{ error?: string }> {
  try {
    await setJobCostLimitAs(actorOf(await requireAppContext()), limit);
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings/ai");
  return {};
}
