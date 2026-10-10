import "server-only";

import { z } from "zod";

import { findAgentByName, getAgent } from "@/lib/agents/store";
import { getIntegration } from "@/lib/integrations";
import { OperationError, visibleFile, type Actor } from "@/lib/operations";
import { getPerson, listPeople } from "@/lib/people";
import { getTask, getTaskByNumber, type Task } from "@/lib/tasks";

// One action people can take in Mach1, declared once: what it's called, what
// it does, what it takes and who may do it. The app's screens perform it
// (performAs), and the Chief of Staff can too, from the catalogue it's given
// (lib/agents/action-tools.ts), so anything added here is in chat as well,
// with the same rules. Inputs name things the way people do (a task's number,
// a person's name) or by id, as screens do; refs below accept either.

/** Where the action is being done from, for the few that need it (sending a file goes back on WhatsApp). */
export type ActionScope = { actor: Actor; whatsapp?: string | null };

export type Action<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  /** "task.set_status": area, then what it does. */
  name: string;
  /** One line: what it does, for the Chief of Staff's catalogue. */
  description: string;
  input: S;
  /** "admin": refused for anyone else before it runs. Finer rules live in run (lib/operations.ts). */
  who?: "member" | "admin";
  /** Returns what happened, in words for the person. */
  run: (scope: ActionScope, input: z.infer<S>) => Promise<string>;
};

export function defineAction<S extends z.ZodTypeAny>(action: Action<S>): Action<S> {
  return action;
}

// ---- Refs: things by id (screens) or as people say them (chat) --------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const taskRef = z.union([z.number().int().positive(), z.string().min(1)]).describe("The task's number (or id).");
export const personRef = z.string().min(1).describe("Their exact name on the Team page (or id).");
export const agentRef = z.string().min(1).describe("The agent's exact name (or id).");
export const fileRef = z.string().min(1).describe("The file's exact name in Files (or id).");

/** A task they can see, by number or id; any other is "doesn't exist". */
export async function taskFor(actor: Actor, ref: number | string): Promise<Task> {
  const viewer = { viewer: actor.personId };
  const task =
    typeof ref === "number" || /^\d+$/.test(ref)
      ? await getTaskByNumber(actor.organizationId, Number(ref), viewer)
      : await getTask(actor.organizationId, ref, viewer);
  if (!task) throw new OperationError(`There's no task ${typeof ref === "number" || /^\d+$/.test(String(ref)) ? `#${ref}` : "like that"}.`);
  return task;
}

export async function personFor(actor: Actor, ref: string) {
  const person = UUID.test(ref)
    ? await getPerson(actor.organizationId, ref)
    : (await listPeople(actor.organizationId)).find((p) => same(p.name, ref));
  if (!person) throw new OperationError(`No one called ${ref} is on the Team page.`);
  return person;
}

export async function agentFor(actor: Actor, ref: string) {
  const agent = UUID.test(ref) ? await getAgent(actor.organizationId, ref) : await findAgentByName(actor.organizationId, ref);
  if (!agent) throw new OperationError(`There's no agent called ${ref}.`);
  return agent;
}

export async function fileFor(actor: Actor, ref: string) {
  return visibleFile(actor, UUID.test(ref) ? { id: ref } : { name: ref });
}

export async function integrationFor(actor: Actor, ref: string) {
  const integration = await getIntegration(actor.organizationId, ref);
  if (!integration) throw new OperationError(`There's no integration called ${ref}.`);
  return integration;
}

/** A person or an agent on the team, by name or id. */
export async function memberFor(actor: Actor, ref: string): Promise<{ personId: string } | { agentId: string }> {
  const person = UUID.test(ref)
    ? await getPerson(actor.organizationId, ref)
    : (await listPeople(actor.organizationId)).find((p) => same(p.name, ref));
  if (person) return { personId: person.id };
  const agent = UUID.test(ref) ? await getAgent(actor.organizationId, ref) : await findAgentByName(actor.organizationId, ref);
  if (agent) return { agentId: agent.id };
  throw new OperationError(`No person or agent called ${ref}.`);
}
