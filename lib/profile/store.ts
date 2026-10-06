import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";

import { emptyProfile } from "./markdown";

// One markdown file holds the company profile. On Vercel it lives in a private
// Vercel Blob; locally (no Blob credentials) it is a file under ./data, or
// under MACH_DATA_DIR when that is set.

const BLOB_PATH = "profile/company-profile.md";

function localPath(): string {
  return path.join(process.env.MACH_DATA_DIR ?? path.join(process.cwd(), "data"), "company-profile.md");
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export async function loadProfile(): Promise<string> {
  if (blobConfigured()) {
    const result = await get(BLOB_PATH, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return emptyProfile();
    return new Response(result.stream).text();
  }
  try {
    return await readFile(localPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProfile();
    throw error;
  }
}

export async function saveProfile(markdown: string): Promise<void> {
  if (blobConfigured()) {
    await put(BLOB_PATH, markdown, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "text/markdown; charset=utf-8",
    });
    return;
  }
  const file = localPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown, "utf8");
}
