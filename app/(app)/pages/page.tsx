import Link from "next/link";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { IdeasLoading, PageIdeaList, PagesEmpty, PinToggle } from "@/components/pages-list";
import { When } from "@/components/ui";
import { pageIdeas } from "@/lib/page-ideas";
import { listPages, pageDataStatus } from "@/lib/pages";
import { requireAppContext } from "@/lib/session";

/** Ideas for this company's pages; written by a model when its profile, integrations or pages change. */
async function Ideas({ organizationId }: { organizationId: string }) {
  return <PageIdeaList ideas={await pageIdeas(organizationId)} />;
}

// Every page the company has, then ideas for more. Pinned pages are also tabs on Home.
export default async function PagesPage() {
  const { organization } = await requireAppContext();
  const pages = (await listPages(organization.id)).filter((p) => p.version > 0);
  const status = await Promise.all(pages.map((p) => pageDataStatus(organization.id, p)));
  const ideas = (
    <Suspense fallback={<IdeasLoading />}>
      <Ideas organizationId={organization.id} />
    </Suspense>
  );

  return (
    <>
      <PageHeader title="Pages" count={pages.length || undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {pages.length === 0 ? (
          <PagesEmpty>{ideas}</PagesEmpty>
        ) : (
          <>
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
                      {status[i].length === 0
                        ? "no data"
                        : status[i].every((f) => f.live)
                          ? "live data"
                          : oldest
                            ? <>data <When date={oldest} /></>
                            : "no data yet"}
                      {page.taskNumber ? ` · #${page.taskNumber}` : ""}
                    </span>
                    <span className="label shrink-0 text-faint">v{page.version}</span>
                    <PinToggle slug={page.slug} pinned={page.pinned} />
                  </li>
                );
              })}
            </ul>
            <section className="mt-10 max-w-2xl space-y-3">
              <h2 className="label">Ideas for more pages</h2>
              {ideas}
            </section>
          </>
        )}
      </div>
    </>
  );
}
