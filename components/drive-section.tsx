"use client";

import { upload } from "@vercel/blob/client";
import { Download, Folder, HardDrive, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";

import { deleteDriveFileAction, registerDriveUploadAction } from "@/app/(app)/files/actions";
import { useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";

// The company data drive on the Files page: shared datasets every job's
// sandbox sees at /vercel/drive. People can download, delete and upload;
// uploads go straight from the browser to Blob.

export type DriveFileView = {
  path: string;
  size: number;
  updatedAt: string;
  taskNumber: number | null;
  by: string | null;
};

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** File names become drive names: odd characters are swapped for dashes. */
const driveName = (name: string) => name.replace(/[^\w .@+=,()-]/g, "-").replace(/^[.\s]+/, "").trim() || "file";
const cleanFolder = (folder: string) =>
  folder
    .split("/")
    .map((part) => driveName(part.trim()))
    .filter((part) => part && part !== "file")
    .join("/");

export function DriveSection({ files, prefix, canUpload }: { files: DriveFileView[]; prefix: string; canUpload: boolean }) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const [folder, setFolder] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const byFolder = new Map<string, DriveFileView[]>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    byFolder.set(dir, [...(byFolder.get(dir) ?? []), file]);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);

  const remove = (path: string, what: string) => {
    if (!confirm(`Delete ${what} from the drive? Jobs that use it won't find it any more.`)) return;
    start(async () => {
      const result = await deleteDriveFileAction(path);
      if (result.error) toast(result.error);
    });
  };

  const send = (chosen: FileList | null) => {
    if (!chosen?.length) return;
    const into = cleanFolder(folder);
    start(async () => {
      for (const file of Array.from(chosen)) {
        const path = into ? `${into}/${driveName(file.name)}` : driveName(file.name);
        try {
          setProgress(`Uploading ${path}…`);
          const blob = await upload(`${prefix}${path}`, file, {
            access: "private",
            handleUploadUrl: "/api/drive/upload",
            multipart: file.size > 20 * 1024 * 1024,
            onUploadProgress: ({ percentage }) => setProgress(`Uploading ${path}… ${Math.round(percentage)}%`),
          });
          const result = await registerDriveUploadAction(path, blob.pathname);
          toast(result.error ?? (result.changed ? `Saved ${path} to the drive` : `${path} is unchanged`));
        } catch (error) {
          toast(`Couldn't upload ${file.name}: ${error instanceof Error ? error.message : "try again"}`);
        }
      }
      setProgress(null);
      if (input.current) input.current.value = "";
    });
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="label flex items-center gap-2">
          <HardDrive size={13} /> Drive
          <span className="text-faint">
            {files.length} file{files.length === 1 ? "" : "s"} · {size(total)}
          </span>
        </h2>
        {canUpload ? (
          <div className="flex items-center gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="folder (optional)"
              className="field w-40 py-1 text-xs"
            />
            <input ref={input} type="file" multiple hidden onChange={(e) => send(e.target.files)} />
            <button onClick={() => input.current?.click()} disabled={pending} className="btn">
              <Upload size={13} /> Upload
            </button>
          </div>
        ) : (
          <span className="text-xs text-faint">Connect a Vercel Blob store to upload.</span>
        )}
      </div>
      {progress && <p className="label mb-2 animate-pulse">{progress}</p>}
      {files.length === 0 ? (
        <p className="border border-dashed border-line px-4 py-5 text-sm text-faint">
          Empty. Datasets that agents save in /vercel/drive, and files you upload, show up here and in every job&apos;s sandbox.
        </p>
      ) : (
        <div className="divide-y divide-line-soft border border-line bg-raised">
          {[...byFolder].map(([dir, items]) => (
            <div key={dir || "/"}>
              {dir && (
                <div className="group flex items-center gap-2 bg-panel px-4 py-1.5">
                  <Folder size={13} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{dir}/</span>
                  <button
                    onClick={() => remove(`${dir}/`, `the ${dir} folder and its ${items.length} files`)}
                    title="Delete this folder"
                    className="text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              <ul className="divide-y divide-line-soft">
                {items.map((file) => (
                  <li key={file.path} className="group flex items-center gap-3 px-4 py-2">
                    <span className={`min-w-0 flex-1 truncate font-mono text-sm ${dir ? "pl-5" : ""}`}>
                      {file.path.slice(dir ? dir.length + 1 : 0)}
                    </span>
                    {file.taskNumber ? (
                      <Link href={`/tasks/${file.taskNumber}`} className="label shrink-0 hover:text-ink">
                        #{file.taskNumber}
                      </Link>
                    ) : (
                      file.by && <span className="label shrink-0 text-faint">{file.by}</span>
                    )}
                    <span className="label hidden w-40 shrink-0 text-right text-faint sm:inline">
                      {size(file.size)} · <When date={file.updatedAt} />
                    </span>
                    <a href={`/drive?path=${encodeURIComponent(file.path)}`} className="text-muted hover:text-ink" title="Download">
                      <Download size={15} />
                    </a>
                    <button
                      onClick={() => remove(file.path, file.path)}
                      title="Delete from the drive"
                      className="text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
