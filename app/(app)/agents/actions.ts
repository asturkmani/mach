"use server";

import { refresh } from "next/cache";

import { performAs } from "@/lib/actions";
import type { AgentStatus } from "@/lib/agents/store";
import { OperationError } from "@/lib/operations";
import { actorOf, requireAppContext } from "@/lib/session";

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

export async function updateAgentAction(id: string, _: AgentActionResult, form: FormData): Promise<AgentActionResult> {
  return perform(id, "agent.update", { agent: id, ...fields(form) });
}

export async function setAgentStatusAction(id: string, status: AgentStatus): Promise<AgentActionResult> {
  return perform(id, "agent.set_status", { agent: id, status });
}

/** Does one of the agent actions (lib/actions/company.ts) as the signed-in person. */
async function perform(id: string, name: string, input: object): Promise<AgentActionResult> {
  try {
    await performAs(actorOf(await requireAppContext()), name, input);
    refresh();
    return { id };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
}
