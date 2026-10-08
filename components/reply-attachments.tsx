"use client";

import { upload } from "@vercel/blob/client";
import { FileText, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";

// Files attached to a reply in a task's thread: picked, pasted or dropped,
// uploaded straight to Blob while the person writes, then sent with the reply.

export type MessageAttachmentView = { versionId: string; name: string; contentType: string; size: number; version: number };

type Pending = {
  key: string;
  name: string;
  size: number;
  contentType: string;
  /** A local preview for images. */
  preview: string | null;
  percent: number;
  blobPathname?: string;
  error?: string;
};

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
/** Images the browser shows inline (SVG is served as a download, so it isn't one). */
const SHOWN = /^image\/(png|jpe?g|gif|webp)$/;

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** A file name that's safe as a library name; pasted images get a dated one, so they don't overwrite each other. */
function nameFor(file: File, n: number): string {
  const clean = file.name.replace(/[\u0000-\u001f/\\]+/g, "-").trim();
  if (clean && !/^image\.(png|jpe?g|gif|webp)$/i.test(clean)) return clean.slice(-120);
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
  return `pasted-${stamp}${n ? `-${n + 1}` : ""}.${ext}`;
}

/** The pending attachments of one reply box. */
export function useReplyAttachments({ prefix, enabled, onError }: { prefix: string; enabled: boolean; onError: (message: string) => void }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const counter = useRef(0);

  const patch = (key: string, change: Partial<Pending>) => setPending((all) => all.map((p) => (p.key === key ? { ...p, ...change } : p)));

  const add = (files: File[]) => {
    if (!files.length) return;
    if (!enabled) return onError("Connect a Vercel Blob store to attach files.");
    const room = MAX_FILES - pending.length;
    if (files.length > room) onError(`Attach at most ${MAX_FILES} files at a time.`);
    files.slice(0, Math.max(0, room)).forEach((file, n) => {
      if (file.size > MAX_BYTES) return onError(`${file.name} is larger than 25 MB.`);
      const key = `a${counter.current++}`;
      const name = nameFor(file, n);
      const preview = SHOWN.test(file.type) ? URL.createObjectURL(file) : null;
      setPending((all) => [...all, { key, name, size: file.size, contentType: file.type, preview, percent: 0 }]);
      upload(`${prefix}${name}`, file, {
        access: "private",
        handleUploadUrl: "/api/uploads",
        multipart: file.size > 20 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => patch(key, { percent: Math.round(percentage) }),
      }).then(
        (blob) => patch(key, { blobPathname: blob.pathname, percent: 100 }),
        (error: unknown) => patch(key, { error: error instanceof Error ? error.message : "Upload failed" }),
      );
    });
  };

  const remove = (key: string) =>
    setPending((all) => {
      const gone = all.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return all.filter((p) => p.key !== key);
    });

  /** Empties the box; keepPreviews leaves the image previews for a message that still shows them. */
  const clear = ({ keepPreviews = false } = {}) =>
    setPending((all) => {
      if (!keepPreviews) all.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      return [];
    });

  return {
    pending,
    add,
    remove,
    clear,
    uploading: pending.some((p) => !p.blobPathname && !p.error),
    failed: pending.some((p) => p.error),
    /** What the reply sends: the uploads that finished. */
    uploads: pending.filter((p) => p.blobPathname).map((p) => ({ name: p.name, blobPathname: p.blobPathname! })),
  };
}

/** The files waiting to go with the reply. */
export function PendingAttachments({ pending, onRemove }: { pending: Pending[]; onRemove: (key: string) => void }) {
  if (!pending.length) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pb-2">
      {pending.map((p) => (
        <li
          key={p.key}
          className={`group relative flex items-center gap-2 border bg-panel py-1 pl-1 pr-2 text-xs ${p.error ? "border-danger/60" : "border-line"}`}
          title={p.error ?? p.name}
        >
          {p.preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL
            <img src={p.preview} alt="" className="h-8 w-8 object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center text-muted">
              <FileText size={15} />
            </span>
          )}
          <span className="max-w-40 truncate">{p.name}</span>
          <span className={p.error ? "text-danger" : "text-faint"}>
            {p.error ? "failed" : p.blobPathname ? formatSize(p.size) : <LoaderCircle size={12} className="animate-spin" />}
          </span>
          {!p.blobPathname && !p.error && <span className="text-faint">{p.percent}%</span>}
          <button type="button" onClick={() => onRemove(p.key)} aria-label={`Remove ${p.name}`} className="text-faint hover:text-ink">
            <X size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Files attached to a message in the thread: images inline, other files as downloads. */
export function MessageAttachments({ attachments }: { attachments: MessageAttachmentView[] }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => SHOWN.test(a.contentType));
  const others = attachments.filter((a) => !SHOWN.test(a.contentType));
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a key={a.versionId} href={`/files/${a.versionId}?inline=1`} target="_blank" rel="noreferrer" title={a.name} className="block border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element -- a private file served by the app */}
              <img src={`/files/${a.versionId}?inline=1`} alt={a.name} loading="lazy" className="max-h-64 max-w-full object-contain sm:max-w-sm" />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {others.map((a) => (
            <li key={a.versionId}>
              <a
                href={`/files/${a.versionId}`}
                className="flex items-center gap-2 border border-line bg-raised px-2.5 py-1.5 text-xs hover:border-muted"
                title={`Download ${a.name}`}
              >
                <FileText size={14} className="text-muted" />
                <span className="max-w-56 truncate">{a.name}</span>
                <span className="text-faint">
                  {a.version > 1 ? `v${a.version} · ` : ""}
                  {formatSize(a.size)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
