import Link from "next/link";
import { after } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { IdeasLoading, PageIdeaList, PagesEmpty, PageThumbnail } from "@/components/pages-list";
import { When } from "@/components/ui";
import { pageIdeas } from "@/lib/page-ideas";
import { listPages, pageDataStatus } from "@/lib/pages";
import { requireAppContext } from "@/lib/session";

/** Ideas for this company's pages; out-of-date ones show while new ones are written after the response. */
async function Ideas({ organizationId }: { organizationId: string }) {
  return <PageIdeaList ideas={await pageIdeas(organizationId, { later: (work) => after(work) })} />;
}

// Every page the company has, as small live pictures of themselves, then ideas for more.
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
            <ul className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3">
              {pages.map((page, i) => {
                const files = status[i];
                const dated = files.filter((f) => f.updatedAt).map((f) => f.updatedAt!.toISOString());
                const oldest = dated.length ? dated.reduce((a, b) => (a < b ? a : b)) : null;
                const freshness =
                  files.length === 0 ? null : files.every((f) => f.live) ? "Live" : oldest ? <>Data <When date={oldest} /></> : "No data yet";
                return (
                  <li key={page.id}>
                    <Link href={`/pages/${page.slug}`} className="group block border border-line bg-raised hover:border-muted">
                      <div className="border-b border-line">
                        <PageThumbnail slug={page.slug} title={page.title} />
                      </div>
                      <div className="space-y-1 px-4 py-3">
                        <p className="truncate text-[15px] group-hover:underline">{page.title}</p>
                        <p className="label truncate text-faint">
                          {freshness}
                          {freshness && page.taskNumber ? " · " : ""}
                          {page.taskNumber ? `refreshed by #${page.taskNumber}` : ""}
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <section className="mt-12 max-w-2xl space-y-3">
              <h2 className="label">Ideas for more pages</h2>
              {ideas}
            </section>
          </>
        )}
      </div>
    </>
  );
}
