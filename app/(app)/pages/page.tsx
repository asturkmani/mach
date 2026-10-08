import { after } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { IdeasLoading, PageIdeaList, PagesHome } from "@/components/pages-list";
import { pageIdeas } from "@/lib/page-ideas";
import { listPages } from "@/lib/pages";
import { requireAppContext } from "@/lib/session";

/** Ideas for this company's pages; out-of-date ones show while new ones are written after the response. */
async function Ideas({ organizationId }: { organizationId: string }) {
  return <PageIdeaList ideas={await pageIdeas(organizationId, { later: (work) => after(work) })} />;
}

// Pages in the left menu: the page looked at last, in its tabs. With no pages
// yet, how to make one, and ideas written for this company.
export default async function PagesPage() {
  const { organization } = await requireAppContext();
  const pages = (await listPages(organization.id))
    .filter((p) => p.version > 0)
    .map((p) => ({ slug: p.slug, title: p.title, description: p.description }));
  return (
    <>
      <PageHeader title="Pages" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <PagesHome pages={pages}>
          <Suspense fallback={<IdeasLoading />}>
            <Ideas organizationId={organization.id} />
          </Suspense>
        </PagesHome>
      </div>
    </>
  );
}
