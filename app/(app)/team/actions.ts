"use server";

import { revalidatePath } from "next/cache";

import type { Role } from "@/lib/members";
import { addPersonAs, invitePersonAs, OperationError, removePersonAs, setManagerAs, setRoleAs, updatePersonAs } from "@/lib/operations";
import type { PersonPatch } from "@/lib/people";
import { actorOf, requireAppContext } from "@/lib/session";

// The Team page's actions. Who may do what lives in lib/operations.ts, which
// the Chief of Staff goes through too.

export type ActionResult = { error?: string; message?: string };

async function run(work: (actor: ReturnType<typeof actorOf>) => Promise<string | void>): Promise<ActionResult> {
  const actor = actorOf(await requireAppContext());
  try {
    const message = await work(actor);
    revalidatePath("/team");
    return { message: message || undefined };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
}

/** Adds someone, and invites them by email straight away when "invite" is ticked (admins only). */
export async function addPersonAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const field = (key: string) => String(form.get(key) ?? "").trim();
  const actor = actorOf(await requireAppContext());
  try {
    const added = await addPersonAs(
      actor,
      { name: field("name"), role: field("role"), manager: field("manager"), email: field("email"), phone: field("phone") },
      { invite: form.get("invite") === "on" },
    );
    revalidatePath("/team");
    return added.warning ? { message: added.message, error: added.warning } : { message: added.message };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    throw error;
  }
}

/** Edits someone's details on the Team page (anyone on the team can, as they can add people). */
export async function updatePersonAction(personId: string, patch: PersonPatch): Promise<ActionResult> {
  return run(async (actor) => void (await updatePersonAs(actor, personId, patch)));
}

export async function setManagerAction(personId: string, managerName: string): Promise<ActionResult> {
  return run((actor) => setManagerAs(actor, personId, managerName));
}

export async function inviteAction(personId: string): Promise<ActionResult> {
  return run((actor) => invitePersonAs(actor, personId));
}

export async function removePersonAction(personId: string): Promise<ActionResult> {
  return run((actor) => removePersonAs(actor, personId));
}

/** Makes someone who has joined an admin, or a member again (admins only, not themselves). */
export async function setRoleAction(personId: string, role: Role): Promise<ActionResult> {
  return run((actor) => setRoleAs(actor, personId, role));
}
