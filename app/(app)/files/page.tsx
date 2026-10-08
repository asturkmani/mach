import Link from "next/link";
import { Download, FileCode, FileSpreadsheet, Paperclip } from "lucide-react";

import { DriveSection } from "@/components/drive-section";
import { PageHeader } from "@/components/page-header";
import { When } from "@/components/ui";
import { listDrive, uploadPrefix } from "@/lib/drive";
import { listLibrary } from "@/lib/files";
import { requireAppContext } from "@/lib/session";
import { blobConnected } from "@/lib/storage";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function FilesPage() {
  const { organization } = await requireAppContext();
  const [files, drive] = await Promise.all([listLibrary(organization.id, { limit: 500 }), listDrive(organization.id)]);
  const deliverables = files.filter((f) => f.kind === "deliverable");
  const code = files.filter((f) => f.kind === "code");

  const list = (items: typeof files) => (
    <ul className="divide-y divide-line-soft border border-line bg-raised">
      {items.map((file) => {
        const latest = file.versions[0];
        const Icon = file.kind === "code" ? FileCode : /\.(xlsx|csv)$/i.test(file.name) ? FileSpreadsheet : Paperclip;
        return (
          <li key={file.id} className="flex items-center gap-3 px-4 py-2.5">
            <Icon size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{file.name}</span>
            <span className="label shrink-0 text-faint">v{latest?.version}</span>
            {latest?.taskNumber && (
              <Link href={`/tasks/${latest.taskNumber}`} className="label shrink-0 hover:text-ink">
                #{latest.taskNumber}
              </Link>
            )}
            <span className="label hidden w-40 shrink-0 text-right text-faint sm:inline">
              {latest ? size(latest.size) : ""} · <When date={new Date(file.updatedAt).toISOString()} />
            </span>
            {latest && (
              <a href={`/files/${latest.id}`} className="text-muted hover:text-ink" title="Download the latest version">
                <Download size={15} />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <PageHeader title="Files" count={files.length} />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 sm:px-8 py-6">
        <div className="max-w-4xl space-y-8">
          <p className="max-w-2xl text-[15px] text-muted">
            Everything agents have produced, with every version. Attach a file to any job and the agent starts from it; what it
            changes is saved as the next version. The drive holds shared data that every job&apos;s sandbox can read and add to.
          </p>
          {deliverables.length > 0 ? (
            <section>
              <h2 className="label mb-3">Deliverables</h2>
              {list(deliverables)}
            </section>
          ) : (
            <p className="text-sm text-faint">No deliverables yet. They appear here when agents attach them to jobs.</p>
          )}
          <DriveSection
            files={drive.map((f) => ({
              path: f.path,
              size: f.size,
              updatedAt: new Date(f.updatedAt).toISOString(),
              taskNumber: f.taskNumber,
              by: f.agentName ?? f.personName,
            }))}
            prefix={uploadPrefix(organization.id)}
            canUpload={blobConnected()}
          />
          {code.length > 0 && (
            <section>
              <h2 className="label mb-3">Code</h2>
              {list(code)}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
