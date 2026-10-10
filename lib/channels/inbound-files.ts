import "server-only";

import type { FileUIPart } from "ai";

import { contentTypeFor, saveVersion } from "@/lib/files";

// Files people send the Chief of Staff by WhatsApp or email: kept in the
// company's file library, private to whoever sent them (as files attached in
// the chat panel are), and handed to the model with their message, so it can
// read them, start a task from them or attach them to one.

export type IncomingFile = { name: string; contentType: string; bytes: Buffer };

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};

/** A name for a file that came without one (WhatsApp doesn't say): "WhatsApp 2026-10-10 14.22 1.pdf". */
export function nameFor(contentType: string, index: number, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
  return `WhatsApp ${stamp} ${index + 1}.${EXTENSIONS[contentType.split(";")[0].trim()] ?? "bin"}`;
}

/** Saves them to the library, private to this person; returns them as the message's file parts. */
export async function keepIncomingFiles(organizationId: string, personId: string, files: IncomingFile[]): Promise<FileUIPart[]> {
  const parts: FileUIPart[] = [];
  for (const file of files) {
    const saved = await saveVersion(organizationId, { name: file.name, kind: "deliverable", bytes: file.bytes, contentType: file.contentType, personId });
    parts.push({ type: "file", mediaType: file.contentType || contentTypeFor(file.name), filename: file.name, url: `/files/${saved.versionId}?inline=1` });
  }
  return parts;
}
