"use server";

import { refresh } from "next/cache";

import { createAgent, getAgent, updateAgent, type AgentStatus } from "@/lib/agents/store";
import { requireAppContext } from "@/lib/session";

export type AgentActionResult = { error?: string; id?: string };

function fields(form: FormData) {
  const field = (key: string) => String(form.get(key) ?? "").trim();
  return {
    name: field("name"),
    role: field("role"),
    description: field("description"),
    instructions: field("instructions"),
    // Only the edit form has the field: absent leaves the model as it is.
    ...(form.has("model") ? { model: field("model") } : {}),
  };
}

export async function createAgentAction(_: AgentActionResult, form: FormData): Promise<AgentActionResult> {
  const { organization } = await requireAppContext();
  const input = fields(form);
  if (!input.name) return { error: "Give the agent a name." };
  try {
    const agent = await createAgent(organization.id, input);
    refresh();
    return { id: agent.id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't create the agent." };
  }
}

export async function updateAgentAction(id: string, _: AgentActionResult, form: FormData): Promise<AgentActionResult> {
  const { organization } = await requireAppContext();
  const input = fields(form);
  if (!input.name) return { error: "Give the agent a name." };
  try {
    await updateAgent(organization.id, id, input);
    refresh();
    return { id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't save the agent." };
  }
}

export async function setAgentStatusAction(id: string, status: AgentStatus): Promise<AgentActionResult> {
  const { organization } = await requireAppContext();
  if (!["active", "paused", "archived"].includes(status)) return { error: "Unknown status." };
  const agent = await getAgent(organization.id, id);
  if (!agent) return { error: "That agent no longer exists." };
  await updateAgent(organization.id, id, { status });
  refresh();
  return { id };
}
