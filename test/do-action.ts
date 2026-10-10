import { actionTools } from "@/lib/agents/action-tools";
import type { Actor } from "@/lib/operations";

/** Performs an action as the Chief of Staff would, with do_action. */
export async function doAction(actor: Actor, action: string, input: object, whatsapp?: string): Promise<string> {
  const tools = actionTools(actor, { whatsapp }) as Record<string, { execute: (input: object, options: object) => Promise<string> }>;
  return tools.do_action.execute({ action, input }, { toolCallId: "t", messages: [] });
}
