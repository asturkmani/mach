"use server";

import { refresh } from "next/cache";

import {
  deleteIntegration,
  forgetSession,
  getIntegration,
  IntegrationError,
  saveCredentials,
  testIntegration,
  updateIntegration,
  type IntegrationStatus,
} from "@/lib/integrations";
import { listAgents } from "@/lib/agents/store";
import { requireAppContext } from "@/lib/session";

// Integrations from the Chief of Staff's card and the Integrations page.
// Credentials go straight from the form to sealed storage: they never pass
// through a model, the chat or a log.

export type IntegrationResult = { error?: string; status?: IntegrationStatus; detail?: string };

async function attempt(work: (organizationId: string) => Promise<IntegrationResult | void>): Promise<IntegrationResult> {
  const { organization } = await requireAppContext();
  try {
    const result = (await work(organization.id)) ?? {};
    refresh();
    return result;
  } catch (error) {
    if (error instanceof IntegrationError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Try again." };
  }
}

/** Saves credentials (blank fields keep their saved value) and tests the connection. */
export async function saveCredentialsAction(id: string, values: Record<string, string>): Promise<IntegrationResult> {
  return attempt(async (organizationId) => {
    await saveCredentials(organizationId, id, values);
    const tested = await testIntegration(organizationId, id);
    return { status: tested.status, detail: tested.statusDetail };
  });
}

export async function testIntegrationAction(id: string): Promise<IntegrationResult> {
  return attempt(async (organizationId) => {
    const tested = await testIntegration(organizationId, id);
    return { status: tested.status, detail: tested.statusDetail };
  });
}

export async function updateIntegrationAction(
  id: string,
  patch: { access?: "read" | "write"; agentIds?: string[] | null; disabled?: boolean },
): Promise<IntegrationResult> {
  return attempt(async (organizationId) => {
    if (!(await getIntegration(organizationId, id))) throw new IntegrationError("That integration doesn't exist.");
    let agentIds = patch.agentIds;
    if (agentIds) {
      const own = new Set((await listAgents(organizationId)).map((a) => a.id));
      agentIds = agentIds.filter((a) => own.has(a));
    }
    await updateIntegration(organizationId, id, { ...patch, agentIds });
  });
}

export async function deleteIntegrationAction(id: string): Promise<IntegrationResult> {
  return attempt(async (organizationId) => {
    await deleteIntegration(organizationId, id);
  });
}

/** Forgets a login's saved session: the next agent to use it signs in afresh. */
export async function forgetSessionAction(id: string): Promise<IntegrationResult> {
  return attempt(async (organizationId) => {
    await forgetSession(organizationId, id);
  });
}
