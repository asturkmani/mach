"use server";

import { refresh } from "next/cache";

import { deletePageAs, OperationError, refreshPageAs, restorePageAs, setPageVisibilityAs, type Actor } from "@/lib/operations";
import { actorOf, requireAppContext } from "@/lib/session";

// What the page screens do. Who may do what lives in lib/operations.ts. Each
// returns an error message for the person rather than throwing, and
// refreshes the page data on success.

export type PageActionResult = { error?: string };

async function attempt(work: (actor: Actor) => Promise<void>): Promise<PageActionResult> {
  const actor = actorOf(await requireAppContext());
  try {
    await work(actor);
    refresh();
    return {};
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Try again." };
  }
}

/** Runs the page's refresh job now. */
export async function refreshPageAction(slug: string): Promise<PageActionResult> {
  return attempt((actor) => refreshPageAs(actor, slug));
}

export async function restorePageAction(slug: string, version: number): Promise<PageActionResult> {
  return attempt((actor) => restorePageAs(actor, slug, version));
}

export async function deletePageAction(slug: string): Promise<PageActionResult> {
  return attempt((actor) => deletePageAs(actor, slug));
}

/** Shares a page (and its refresh job) with the company, or makes it private to whoever made it (they, or an admin). */
export async function setPageVisibilityAction(slug: string, visibility: "company" | "private"): Promise<PageActionResult> {
  return attempt((actor) => setPageVisibilityAs(actor, slug, visibility === "company" ? "company" : "private"));
}
