import "server-only";

import { companyActions } from "@/lib/actions/company";
import type { Action, ActionScope } from "@/lib/actions/define";
import { taskActions } from "@/lib/actions/tasks";
import { OperationError, type Actor } from "@/lib/operations";

// Every action people can take in Mach1 (lib/actions/define.ts). The screens
// perform them; the Chief of Staff reads the catalogue and performs them with
// do_action. A test (actions.test.ts) fails when a screen's server action
// doesn't go through here, so nothing new is missing from chat.

export const ACTIONS: Action[] = [...taskActions, ...companyActions];

const byName = new Map(ACTIONS.map((a) => [a.name, a]));

export const getAction = (name: string) => byName.get(name);

/** One line per action, for the Chief of Staff: name(inputs): what it does. */
export function actionCatalog({ isAdmin }: { isAdmin: boolean }): string {
  return ACTIONS.filter((a) => isAdmin || a.who !== "admin")
    .map((a) => {
      const shape = "shape" in a.input ? Object.keys((a.input as unknown as { shape: Record<string, unknown> }).shape) : [];
      return `- ${a.name}(${shape.join(", ")}): ${a.description}`;
    })
    .join("\n");
}

/** Performs an action as someone: checks its input and who may do it, then runs it. Throws OperationError for the person. */
export async function performAs(scope: ActionScope | Actor, name: string, input: unknown): Promise<string> {
  const { actor, whatsapp } = "actor" in scope ? scope : { actor: scope, whatsapp: null };
  const action = byName.get(name);
  if (!action) throw new OperationError(`There's no action called ${name}.`);
  if (action.who === "admin" && !actor.isAdmin) throw new OperationError(`Only admins can do that (${name}).`);
  const parsed = action.input.safeParse(input ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new OperationError(`That doesn't fit ${name}: ${problems}.`);
  }
  return action.run({ actor, whatsapp }, parsed.data);
}
