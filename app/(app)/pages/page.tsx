import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { PagesEmpty, PinToggle } from "@/components/pages-list";
import { When } from "@/components/ui";
import { listPages, pageDataStatus } from "@/lib/pages";
import { requireAppContext } from "@/lib/session";

// Every page the company has. Pinned ones are also tabs on Home.
export default async function PagesPage() {
  const { organization } = await requireAppContext();
  const pages = (await listPages(organization.id)).filter((p) => p.version > 0);
  const status = await Promise.all(pages.map((p) => pageDataStatus(organization.id, p)));

  return (
    <>
      <PageHeader title="Pages" count={pages.length || undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {pages.length === 0 ? (
          <PagesEmpty />
        ) : (
          <ul className="divide-y divide-line-soft border border-line bg-raised">
            {pages.map((page, i) => {
              const dated = status[i].filter((f) => f.updatedAt).map((f) => f.updatedAt!.toISOString());
              const oldest = dated.length ? dated.reduce((a, b) => (a < b ? a : b)) : null;
              return (
                <li key={page.id} className="flex items-center gap-4 px-4 py-3">
                  <Link href={`/pages/${page.slug}`} className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] hover:underline">{page.title}</span>
                    {page.description && <span className="block truncate text-sm text-muted">{page.description}</span>}
                  </Link>
                  <span className="label hidden shrink-0 text-faint sm:inline">
                    {status[i].length ? (oldest ? <>data <When date={oldest} /></> : "no data yet") : "no data"}
                    {page.taskNumber ? ` · #${page.taskNumber}` : ""}
                  </span>
                  <span className="label shrink-0 text-faint">v{page.version}</span>
                  <PinToggle slug={page.slug} pinned={page.pinned} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
