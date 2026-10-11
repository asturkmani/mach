import "server-only";

import { companyActions } from "@/lib/actions/company";
import type { z } from "zod";

import { agentRef, fileRef, personRef, taskRef, type Action, type ActionScope } from "@/lib/actions/define";
import { researchActions } from "@/lib/actions/research";
import { skillActions } from "@/lib/actions/skills";
import { taskActions } from "@/lib/actions/tasks";
import { OperationError, type Actor } from "@/lib/operations";

// Every action people can take in Mach1 (lib/actions/define.ts). The screens
// perform them; the Chief of Staff reads the catalogue and performs them with
// do_action. A test (actions.test.ts) fails when a screen's server action
// doesn't go through here, so nothing new is missing from chat.

export const ACTIONS: Action[] = [...taskActions, ...companyActions, ...researchActions, ...skillActions];

const byName = new Map(ACTIONS.map((a) => [a.name, a]));

export const getAction = (name: string) => byName.get(name);

/** One line per action, for the Chief of Staff: name(inputs): what it does, then what its inputs take. */
export function actionCatalog({ isAdmin }: { isAdmin: boolean }): string {
  return ACTIONS.filter((a) => isAdmin || a.who !== "admin")
    .map((a) => {
      const shape = "shape" in a.input ? (a.input as unknown as { shape: Record<string, z.ZodType> }).shape : {};
      const fields = Object.entries(shape).map(([key, field]) => ({ key, ...describeField(field) }));
      const notes = fields.filter((f) => f.note && !SHARED_REFS.has(f.note)).map((f) => `${f.key}: ${f.note}`);
      const inputs = fields.map((f) => `${f.key}${f.optional ? "?" : ""}`).join(", ");
      return `- ${a.name}(${inputs}): ${a.description}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
    })
    .join("\n");
}

// Said once in the instructions rather than on every line.
const SHARED_REFS = new Set([taskRef, personRef, agentRef, fileRef].map((ref) => ref.description));

/** Whether an input may be left out, and what it takes: its description, or its allowed values. */
function describeField(field: z.ZodType): { optional: boolean; note?: string } {
  let inner = field;
  let optional = false;
  // Optional, nullable and defaulted inputs wrap the real one.
  while (["optional", "nullable", "default"].includes(inner.def.type)) {
    optional = true;
    inner = (inner.def as unknown as { innerType: z.ZodType }).innerType;
  }
  const values = inner.def.type === "enum" ? (inner as unknown as z.ZodEnum).options.join("|") : undefined;
  return { optional, note: field.description ?? inner.description ?? values };
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
