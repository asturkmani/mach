import "server-only";

import { del as deleteBlob, get as getBlob, put as putBlob } from "@vercel/blob";

// Where file content lives: Vercel Blob (private) when a store is connected to
// the project, otherwise a bytea column next to the row that describes it.
// Rows keep either a blob pathname or the content itself, and are read back
// the same way.

/** True when a Blob store is connected (a read-write token, or OIDC with a store id). */
export const blobConnected = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

export type StoredBytes = { blobPathname: string | null; content: Buffer | null };

/**
 * Stores bytes under a pathname. `unique` adds a random suffix, for content
 * that is replaced in place (so a reader never gets a cached older copy).
 */
export async function storeBytes(
  pathname: string,
  bytes: Buffer,
  contentType: string,
  { unique = false }: { unique?: boolean } = {},
): Promise<StoredBytes> {
  if (!blobConnected()) return { blobPathname: null, content: bytes };
  const blob = await putBlob(pathname, bytes, {
    access: "private",
    contentType,
    addRandomSuffix: unique,
    allowOverwrite: !unique,
  });
  return { blobPathname: blob.pathname, content: null };
}

export async function loadBytes(row: { blob_pathname: string | null; content: Uint8Array | null }): Promise<Buffer> {
  if (row.content) return Buffer.from(row.content);
  if (!row.blob_pathname) return Buffer.alloc(0);
  const blob = await getBlob(row.blob_pathname, { access: "private" });
  if (!blob) throw new Error(`File content is missing from Blob storage (${row.blob_pathname}).`);
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}

/** Deletes stored content that nothing points to any more. */
export async function removeBytes(blobPathname: string | null): Promise<void> {
  if (!blobPathname || !blobConnected()) return;
  await deleteBlob(blobPathname).catch((error) => console.error(`Couldn't delete ${blobPathname} from Blob`, error));
}
