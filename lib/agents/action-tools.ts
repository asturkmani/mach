import "server-only";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { getAction, performAs } from "@/lib/actions";
import { OperationError, type Actor } from "@/lib/operations";
import { WorkError } from "@/lib/work";

// The Chief of Staff performs any action in Mach1's catalogue (lib/actions)
// as the person it's talking to, with their permissions: the same code the
// screens run. New actions need nothing here.

export function actionTools(actor: Actor | null, { whatsapp }: { whatsapp?: string | null } = {}): ToolSet {
  if (!actor) return {};
  return {
    do_action: tool({
      description:
        "Do one of the actions in the app's catalogue (in your instructions) as the person you're talking to, with their permissions. Pass the action's name and its inputs as an object; things are named the way people say them (a task's number, a person's or agent's exact name, a file's name). It says what happened, or why not.",
      inputSchema: z.object({
        action: z.string().describe('e.g. "task.set_status"'),
        input: z.object({}).catchall(z.unknown()).default({}),
      }),
      execute: async ({ action, input }) => {
        try {
          return await performAs({ actor, whatsapp }, action, input);
        } catch (error) {
          if (error instanceof OperationError || error instanceof WorkError) {
            const known = getAction(action);
            return `Not done: ${error.message}${known ? "" : " Pick a name from the catalogue."}`;
          }
          throw error;
        }
      },
    }),
  };
}
