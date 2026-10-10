"use server";

import { revalidatePath } from "next/cache";

import { AiKeyError, removeAiKey, saveAiKey } from "@/lib/ai/keys";
import { setCompanyModels, type CompanyModels } from "@/lib/orgs";
import { requireAppContext } from "@/lib/session";

/** Adds or replaces the company's key for a provider, once the provider accepts it (admins only). */
export async function saveAiKeyAction(provider: string, apiKey: string): Promise<{ error?: string }> {
  const { organization, person, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change the company's AI keys." };
  try {
    await saveAiKey(organization.id, provider, apiKey, person.id);
  } catch (error) {
    if (error instanceof AiKeyError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings/ai");
  return {};
}

export async function removeAiKeyAction(provider: string): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can change the company's AI keys." };
  await removeAiKey(organization.id, provider);
  revalidatePath("/settings/ai");
  return {};
}

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

/** The company's own default models for its Chief of Staff and agents (admins only); empty uses Mach1's. */
export async function saveCompanyModelsAction(models: CompanyModels): Promise<{ error?: string }> {
  const { organization, isAdmin } = await requireAppContext();
  if (!isAdmin) return { error: "Only admins can choose the company's models." };
  for (const id of Object.values(models)) {
    if (id?.trim() && !MODEL_ID.test(id.trim())) return { error: `${id} isn't a model id. Use provider/model, e.g. anthropic/claude-sonnet-4.5.` };
  }
  await setCompanyModels(organization.id, models);
  revalidatePath("/settings/ai");
  return {};
}
