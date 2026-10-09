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
import { sendLoginCode } from "@/lib/agents/browser-steps";
import { listAgents } from "@/lib/agents/store";
import { listPeople } from "@/lib/people";
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
  patch: { access?: "read" | "write"; agentIds?: string[] | null; personIds?: string[] | null; disabled?: boolean },
): Promise<IntegrationResult> {
  const { isAdmin } = await requireAppContext();
  if (patch.personIds !== undefined && !isAdmin) return { error: "Only admins choose whose work may use it." };
  return attempt(async (organizationId) => {
    if (!(await getIntegration(organizationId, id))) throw new IntegrationError("That integration doesn't exist.");
    let agentIds = patch.agentIds;
    if (agentIds) {
      const own = new Set((await listAgents(organizationId)).map((a) => a.id));
      agentIds = agentIds.filter((a) => own.has(a));
    }
    let personIds = patch.personIds;
    if (personIds) {
      const own = new Set((await listPeople(organizationId)).map((p) => p.id));
      personIds = personIds.filter((p) => own.has(p));
    }
    await updateIntegration(organizationId, id, { ...patch, agentIds, personIds });
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

/** Hands a sign-in code from the chat's code card to the Chief of Staff's waiting browser. */
export async function sendSignInCodeAction(slug: string, code: string): Promise<{ error?: string }> {
  const { organization, person } = await requireAppContext();
  try {
    return await sendLoginCode(organization.id, person.id, slug, code);
  } catch (error) {
    console.error(error);
    return { error: "Couldn't hand over the code. Ask the Chief of Staff to sign in again." };
  }
}
