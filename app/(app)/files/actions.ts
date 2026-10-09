"use server";

import { refresh } from "next/cache";

import { deleteDriveFile, registerDriveUpload } from "@/lib/drive";
import { listLibrary, setFileVisibility } from "@/lib/files";
import { requireAppContext } from "@/lib/session";

// The company drive, from the Files page: register a file someone uploaded
// straight to Blob, or delete files. Each returns an error for the person
// rather than throwing.

export async function registerDriveUploadAction(path: string, blobPathname: string): Promise<{ error?: string; changed?: boolean }> {
  const { organization, person } = await requireAppContext();
  try {
    const result = await registerDriveUpload(organization.id, { path, blobPathname, personId: person.id });
    refresh();
    return { changed: result.changed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't save that file." };
  }
}

/** Deletes a file, or a folder and everything in it when the path ends with "/". */
export async function deleteDriveFileAction(path: string): Promise<{ error?: string }> {
  const { organization } = await requireAppContext();
  try {
    await deleteDriveFile(organization.id, path);
    refresh();
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't delete that." };
  }
}

/** Shares a library file with the company, or makes it private again (its owner, or an admin). */
export async function setFileVisibilityAction(fileId: string, visibility: "company" | "private"): Promise<{ error?: string }> {
  const { organization, person, isAdmin } = await requireAppContext();
  const file = (await listLibrary(organization.id, { limit: 1000, viewer: person.id })).find((f) => f.id === fileId);
  if (!file) return { error: "That file doesn't exist." };
  if (file.ownerPersonId !== person.id && !isAdmin) return { error: "Only its owner, or an admin, can change who sees it." };
  await setFileVisibility(organization.id, fileId, visibility === "company" ? "company" : "private");
  refresh();
  return {};
}
