"use client";

import { ChevronRight, Download, FileCode, FileSpreadsheet, Files, Paperclip, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { attachFileAction, detachFileAction } from "@/app/(app)/tasks/actions";
import { useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";

// A job's files: deliverables up front with previews and versions, the code
// that produced them one click away, and the job's notes.

export type Preview =
  | { type: "sheets"; sheets: { name: string; rows: string[][]; moreRows: number; moreColumns: number }[] }
  | { type: "table"; rows: string[][]; moreRows: number }
  | { type: "markdown"; text: string }
  | { type: "text"; text: string }
  | { type: "image" }
  | null;

export type FileVersionView = {
  id: string;
  version: number;
  size: number;
  contentType: string;
  taskNumber: number | null;
  agentName: string | null;
  basedOn: number | null;
  note: string;
  createdAt: string;
};

export type FileView = {
  id: string;
  name: string;
  kind: "deliverable" | "code";
  role: "input" | "output";
  versions: FileVersionView[];
};

/** Loads a version's preview once it's wanted; previews are built and stored on the server. */
function usePreview(versionId: string | undefined, wanted: boolean): Preview | "loading" {
  const [loaded, setLoaded] = useState<{ id: string; preview: Preview } | null>(null);
  useEffect(() => {
    if (!wanted || !versionId || loaded?.id === versionId) return;
    let cancelled = false;
    fetch(`/files/${versionId}/preview`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((preview: Preview) => {
        if (!cancelled) setLoaded({ id: versionId, preview });
      });
    return () => {
      cancelled = true;
    };
  }, [versionId, wanted, loaded?.id]);
  return loaded && loaded.id === versionId ? loaded.preview : "loading";
}

export type LibraryOption = { id: string; name: string; version: number; taskNumber: number | null };

const download = (versionId: string) => `/files/${versionId}`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Table({ rows, header = true }: { rows: string[][]; header?: boolean }) {
  const [head, ...body] = header ? rows : [[], ...rows];
  const numeric = (cell: string) => /^[-$€£(]?[\d,.]+%?\)?$/.test(cell.trim());
  return (
    <table className="w-max min-w-full border-collapse font-mono text-xs">
      {header && head.length > 0 && (
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                className={`sticky top-0 border-b border-line bg-raised px-3 py-2 font-normal whitespace-nowrap text-muted ${
                  i === 0 ? "left-0 z-20 text-left" : "z-10 text-right"
                }`}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {body.map((row, r) => (
          <tr key={r} className="group/row">
            {row.map((cell, i) => (
              <td
                key={i}
                title={cell}
                className={`max-w-64 truncate border-b border-line-soft px-3 py-1.5 group-hover/row:bg-hover ${
                  i === 0 ? "sticky left-0 z-10 bg-raised text-left" : numeric(cell) ? "text-right tabular-nums" : "text-left"
                }`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PreviewBody({ file, versionId }: { file: FileView; versionId: string }) {
  const [sheet, setSheet] = useState(0);
  const preview = usePreview(versionId, true);
  if (preview === "loading") return <p className="label animate-pulse px-4 py-3">Loading preview…</p>;
  if (!preview) {
    return <p className="px-4 py-3 text-sm text-faint">No preview for this kind of file. Download it to open it.</p>;
  }
  if (preview.type === "image") {
    return (
      // Private, authenticated files: next/image's optimizer can't fetch them.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`${download(versionId)}?inline=1`}
        alt={file.name}
        loading="lazy"
        className="mx-auto min-h-40 max-h-[28rem] bg-white object-contain p-2"
      />
    );
  }
  if (preview.type === "markdown") {
    return (
      <div className="prose prose-mach max-w-none px-4 py-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.text}</ReactMarkdown>
      </div>
    );
  }
  if (preview.type === "text") return <pre className="px-4 py-3 font-mono text-xs whitespace-pre-wrap">{preview.text}</pre>;
  if (preview.type === "table") {
    return (
      <>
        <Table rows={preview.rows} />
        {preview.moreRows > 0 && <p className="px-3 py-2 text-xs text-faint">{preview.moreRows} more rows in the file</p>}
      </>
    );
  }
  const current = preview.sheets[Math.min(sheet, preview.sheets.length - 1)];
  return (
    <>
      {preview.sheets.length > 1 && (
        <div className="sticky left-0 flex gap-1 border-b border-line-soft px-2 pt-2">
          {preview.sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setSheet(i)}
              className={`border border-b-0 px-3 py-1 font-mono text-xs ${
                i === sheet ? "border-line bg-raised text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {current && current.rows.length > 0 ? (
        <Table rows={current.rows} header={false} />
      ) : (
        <p className="px-4 py-3 text-sm text-faint">This sheet is empty.</p>
      )}
      {current && (current.moreRows > 0 || current.moreColumns > 0) && (
        <p className="px-3 py-2 text-xs text-faint">
          Preview only: {[current.moreRows && `${current.moreRows} more rows`, current.moreColumns && `${current.moreColumns} more columns`]
            .filter(Boolean)
            .join(" and ")}{" "}
          in the file.
        </p>
      )}
    </>
  );
}

function versionLabel(v: FileVersionView, taskNumber: number): string {
  const where = v.taskNumber && v.taskNumber !== taskNumber ? `from #${v.taskNumber}` : v.agentName ? `by ${v.agentName}` : "";
  return [where, v.note.split("\n")[0]].filter(Boolean).join(" · ");
}

function DeliverableCard({ file, taskNumber, taskId, startOpen }: { file: FileView; taskNumber: number; taskId: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [history, setHistory] = useState(false);
  const [, start] = useTransition();
  const latest = file.versions[0];
  if (!latest) return null;
  const Icon = /\.(xlsx|csv)$/i.test(file.name) ? FileSpreadsheet : Paperclip;
  return (
    <div className="border border-line bg-raised">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-2 text-left hover:text-accent">
          <Icon size={15} className="shrink-0 text-muted" />
          <span className="truncate font-mono text-sm">{file.name}</span>
          <span className="label shrink-0 text-faint">v{latest.version}</span>
          {file.role === "input" && <span className="label shrink-0 text-accent">Input</span>}
        </button>
        <span className="flex shrink-0 items-center gap-3">
          <span className="label hidden text-faint sm:inline">
            {size(latest.size)} · <When date={latest.createdAt} />
          </span>
          {file.versions.length > 1 && (
            <button onClick={() => setHistory(!history)} className="label text-faint hover:text-ink">
              {file.versions.length} versions
            </button>
          )}
          <a href={download(latest.id)} className="text-muted hover:text-ink" title="Download">
            <Download size={15} />
          </a>
          {file.role === "input" && (
            <button
              title="Remove from this job"
              onClick={() => start(async () => void (await detachFileAction(taskId, file.id)))}
              className="text-faint hover:text-danger"
            >
              <X size={14} />
            </button>
          )}
        </span>
      </div>
      {history && (
        <ul className="border-t border-line-soft px-4 py-2 text-sm">
          {file.versions.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 py-1">
              <span className="min-w-0 truncate">
                <span className="font-mono">v{v.version}</span>
                <span className="text-muted"> {versionLabel(v, taskNumber)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-xs text-faint">
                <When date={v.createdAt} />
                <a href={download(v.id)} className="hover:text-ink" title={`Download version ${v.version}`}>
                  <Download size={13} />
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="scroll-quiet max-h-[30rem] overflow-auto border-t border-line-soft">
          <PreviewBody file={file} versionId={latest.id} />
        </div>
      )}
    </div>
  );
}

export function FilesSection({
  taskId,
  taskNumber,
  files,
  library,
}: {
  taskId: string;
  taskNumber: number;
  files: FileView[];
  library: LibraryOption[];
}) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  // The main deliverable first: spreadsheets, then charts and documents, then anything else.
  const rank = (name: string) =>
    [/\.(xlsx|xls|csv)$/i, /\.(png|jpe?g|svg|gif|webp)$/i, /\.(pdf|docx|pptx)$/i, /\.(md|txt|json)$/i].findIndex((re) =>
      re.test(name),
    ) >>> 0;
  const deliverables = files.filter((f) => f.kind === "deliverable").sort((a, b) => rank(a.name) - rank(b.name));
  if (deliverables.length === 0 && library.length === 0) return null;
  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center justify-between">
        <p className="label">Files</p>
        {library.length > 0 && (
          <select
            value=""
            disabled={pending}
            onChange={(e) => {
              const fileId = e.target.value;
              if (!fileId) return;
              start(async () => {
                const result = await attachFileAction(taskId, fileId);
                if (result.error) toast(result.error);
              });
            }}
            className="max-w-60 bg-transparent text-sm text-faint outline-none hover:text-ink"
          >
            <option value="">Attach a company file…</option>
            {library.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} (v{f.version}
                {f.taskNumber ? `, #${f.taskNumber}` : ""})
              </option>
            ))}
          </select>
        )}
      </div>
      {deliverables.map((file, i) => (
        <DeliverableCard key={file.id} file={file} taskNumber={taskNumber} taskId={taskId} startOpen={i === 0} />
      ))}
    </section>
  );
}

/** The scripts behind the deliverables: there to check or rerun, not in the way. */
export function CodeSection({ files, notes }: { files: FileView[]; notes: string }) {
  const [open, setOpen] = useState(false);
  const code = files.filter((f) => f.kind === "code");
  if (code.length === 0 && !notes.trim()) return null;
  return (
    <section className="mt-6 space-y-2">
      {code.length > 0 && (
        <details className="group border border-line-soft" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-muted hover:text-ink">
            <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
            <FileCode size={14} />
            Code · {code.length} {code.length === 1 ? "script" : "scripts"}
          </summary>
          <div className="space-y-4 border-t border-line-soft px-4 py-4">
            {open && code.map((file) => <Script key={file.id} file={file} />)}
          </div>
        </details>
      )}
      {notes.trim() && (
        <details className="group border border-line-soft">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-muted hover:text-ink">
            <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
            <Files size={14} />
            Job notes
          </summary>
          <div className="prose prose-mach max-w-none border-t border-line-soft px-4 py-3 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
          </div>
        </details>
      )}
    </section>
  );
}

function Script({ file }: { file: FileView }) {
  const latest = file.versions[0];
  const preview = usePreview(latest?.id, true);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-sm">
          {file.name} <span className="label text-faint">v{latest?.version}</span>
        </span>
        {latest && (
          <a href={download(latest.id)} className="text-faint hover:text-ink" title="Download">
            <Download size={14} />
          </a>
        )}
      </div>
      {preview === "loading" ? (
        <p className="label animate-pulse">Loading…</p>
      ) : (
        preview?.type === "text" && (
          <pre className="scroll-quiet max-h-80 overflow-auto border border-line-soft bg-bg px-3 py-2 font-mono text-xs leading-relaxed">
            {preview.text}
          </pre>
        )
      )}
      {latest?.note && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-faint hover:text-ink">Last run output</summary>
          <pre className="scroll-quiet mt-1 max-h-60 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted">
            {latest.note}
          </pre>
        </details>
      )}
    </div>
  );
}
