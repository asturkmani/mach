import "server-only";

import type { FileUIPart, UIMessage } from "ai";

import { imageForModel, MODEL_IMAGE_TYPES } from "@/lib/agents/images";
import { contentTypeFor, discardUploads, isText, readUpload, readVersion, saveVersion } from "@/lib/files";

// Files attached in the Chief of Staff chat. Each is saved to the company's
// file library, so a task can start from it (create_task's files), and kept
// in the chat as a file part pointing at the library. The model sees the
// newest message's attachments: images as pictures, small text files as text,
// anything else by name. Older attachments are mentioned by name only.

export type ChatUpload = { name: string; blobPathname: string };

/** The same limit as a reply in a task's thread. */
export const MAX_CHAT_ATTACHMENTS = 10;
const MAX_TEXT_BYTES = 100_000;
const MAX_TEXT_CHARS = 20_000;

/** Takes uploads (already in Blob, from /api/uploads) into the library; returns the chat's file parts. */
export async function saveChatAttachments(
  organizationId: string,
  personId: string,
  uploads: ChatUpload[],
): Promise<FileUIPart[]> {
  if (uploads.length > MAX_CHAT_ATTACHMENTS) throw new Error(`Attach at most ${MAX_CHAT_ATTACHMENTS} files at a time.`);
  const parts: FileUIPart[] = [];
  for (const upload of uploads) {
    let bytes: Buffer;
    try {
      bytes = await readUpload(organizationId, upload.blobPathname);
    } catch {
      throw new Error(`Couldn't read ${upload.name}. Remove it and attach it again.`);
    }
    const saved = await saveVersion(organizationId, { name: upload.name, kind: "deliverable", bytes, personId });
    parts.push({ type: "file", mediaType: contentTypeFor(upload.name), filename: upload.name, url: `/files/${saved.versionId}?inline=1` });
  }
  await discardUploads(organizationId, uploads.map((u) => u.blobPathname));
  return parts;
}

const versionOf = (part: FileUIPart) => part.url.match(/^\/files\/([^/?#]+)/)?.[1] ?? null;
const isFile = (part: UIMessage["parts"][number]): part is FileUIPart => part.type === "file";

/**
 * The conversation as the model gets it. Stored file parts point at the app's
 * own (private) file URLs, which a provider can't fetch, so they're turned
 * into what the model can use; the stored conversation keeps the originals.
 * Reasoning from earlier turns is left out: models don't use it, and one
 * from another provider (after the company changed its model) can't read it.
 */
export async function forModel(organizationId: string, messages: UIMessage[]): Promise<UIMessage[]> {
  const newest = messages.findLastIndex((m) => m.role === "user");
  return Promise.all(
    messages.map(async (original, index) => {
      const message =
        index < newest && original.role === "assistant" && original.parts.some((p) => p.type === "reasoning")
          ? { ...original, parts: original.parts.filter((p) => p.type !== "reasoning") }
          : original;
      const files = message.parts.filter(isFile);
      if (files.length === 0) return message;
      const others = message.parts.filter((p) => !isFile(p));
      if (index !== newest) {
        const names = files.map((f) => f.filename ?? "a file").join(", ");
        return { ...message, parts: [...others, { type: "text" as const, text: `[Attached earlier, now in the company files: ${names}]` }] };
      }

      const shown: UIMessage["parts"] = [];
      const notes: string[] = [];
      for (const file of files) {
        const name = file.filename ?? "a file";
        const versionId = versionOf(file);
        const stored = versionId ? await readVersion(organizationId, versionId) : null;
        if (!stored) {
          notes.push(`${name} (couldn't be read)`);
          continue;
        }
        const type = file.mediaType || contentTypeFor(name);
        if (MODEL_IMAGE_TYPES.test(type)) {
          try {
            const image = await imageForModel(stored.bytes);
            shown.push({ type: "file", mediaType: image.mediaType, filename: name, url: `data:${image.mediaType};base64,${image.data}` });
            notes.push(`${name} (an image, shown below)`);
            continue;
          } catch {
            // Not a readable image after all: passed on by name like any other file.
          }
        }
        if (isText(type) && stored.bytes.length <= MAX_TEXT_BYTES) {
          const text = stored.bytes.toString("utf8");
          shown.push({
            type: "text",
            text: `<file name="${name}">\n${text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…cut]` : text}\n</file>`,
          });
          notes.push(`${name} (its text is below)`);
          continue;
        }
        notes.push(`${name} (${type})`);
      }
      const note = `[They attached ${files.length === 1 ? "a file" : `${files.length} files`}, saved to the company files under these names: ${notes.join("; ")}. To work on a file you can't read here, create a task that starts from it.]`;
      return { ...message, parts: [...others, { type: "text" as const, text: note }, ...shown] };
    }),
  );
}

/** Puts the stored versions of the conversation's own messages back after a run, so data URLs are never saved. */
export function restoreOriginals(finished: UIMessage[], originals: UIMessage[]): UIMessage[] {
  const byId = new Map(originals.map((m) => [m.id, m]));
  return finished.map((m) => byId.get(m.id) ?? m);
}
