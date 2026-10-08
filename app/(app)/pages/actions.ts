"use server";

import { refresh } from "next/cache";

import { deletePage, getPage, PageError, restorePageVersion } from "@/lib/pages";
import { requireAppContext } from "@/lib/session";
import { rerunScript, WorkError } from "@/lib/work";

// What the page screens do. Each returns an error message for the person
// rather than throwing, and refreshes the page data on success.

export type PageActionResult = { error?: string };

async function attempt(work: (context: Awaited<ReturnType<typeof requireAppContext>>) => Promise<void>): Promise<PageActionResult> {
  const context = await requireAppContext();
  try {
    await work(context);
    refresh();
    return {};
  } catch (error) {
    if (error instanceof PageError || error instanceof WorkError) return { error: error.message };
    console.error(error);
    return { error: "Something went wrong. Try again." };
  }
}

/** Runs the page's refresh job now. */
export async function refreshPageAction(slug: string): Promise<PageActionResult> {
  return attempt(async ({ organization, person }) => {
    const page = await getPage(organization.id, slug);
    if (!page?.taskId) throw new PageError("This page has no refresh job. Ask the Chief of Staff to set one up.");
    await rerunScript(organization.id, page.taskId, { name: person.name, personId: person.id });
  });
}

export async function restorePageAction(slug: string, version: number): Promise<PageActionResult> {
  return attempt(async ({ organization, person }) => {
    await restorePageVersion(organization.id, slug, version, { name: person.name, personId: person.id });
  });
}

export async function deletePageAction(slug: string): Promise<PageActionResult> {
  return attempt(({ organization, person }) => deletePage(organization.id, slug, { name: person.name, personId: person.id }));
}
