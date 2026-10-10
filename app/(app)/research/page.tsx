import Link from "next/link";

import { PageBody, Section } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { AddSourceForm, AskResearcher, SourceTable } from "@/components/research-sources";
import { When } from "@/components/ui";
import { findBuiltinAgent, RESEARCH_AGENT } from "@/lib/agents/store";
import { listSources } from "@/lib/research/store";
import { sourceLabel, sourceUrl } from "@/lib/research/sources";
import { requireAppContext } from "@/lib/session";
import { STATUS_WORDS } from "@/lib/task-words";
import { listAgentTasks } from "@/lib/tasks";

// @map Research | Left menu → Research | The sources you trust most (websites, X accounts, subreddits, Reddit users), which the Researcher looks at first: yours and the company's, with adding, sharing and removing them; and the Researcher's recent work.
export default async function ResearchPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  const [sources, researcher] = await Promise.all([
    listSources(organization.id, { viewer: person.id }),
    findBuiltinAgent(organization.id, RESEARCH_AGENT),
  ]);
  const tasks = researcher ? (await listAgentTasks(organization.id, researcher.id, { viewer: person.id })).slice(0, 12) : [];

  return (
    <>
      <PageHeader title="Research">
        <AskResearcher />
      </PageHeader>
      <PageBody width="4xl" className="space-y-12">
        <Section
          title="High-signal sources"
          count={sources.length}
          addLabel="Add source"
          description={
            <>
              Where the Researcher looks first, and what it weighs highest. Yours are just yours unless you share them; the company&apos;s count in
              everyone&apos;s research. You can also tell your Chief of Staff, e.g. &ldquo;save @DeItaone as high signal for macro news&rdquo;.
            </>
          }
          form={<AddSourceForm />}
        >
          {sources.length === 0 ? (
            <p className="text-sm text-faint">
              None yet. Add the websites, X accounts, subreddits and Reddit users whose takes you trust.
            </p>
          ) : (
            <SourceTable
              sources={sources.map((s) => ({
                id: s.id,
                kind: s.kind,
                label: sourceLabel(s),
                url: sourceUrl(s),
                note: s.note,
                visibility: s.visibility,
                mine: s.ownerPersonId === person.id,
                canChange: s.ownerPersonId === person.id || isAdmin,
              }))}
            />
          )}
        </Section>

        <section>
          <h2 className="label mb-3">The Researcher&apos;s recent work</h2>
          {tasks.length === 0 ? (
            <p className="text-sm text-faint">
              Nothing yet. Ask your Chief of Staff for research (&ldquo;a brief on Micron&apos;s HBM outlook&rdquo;, &ldquo;what are people saying about the
              Fed?&rdquo;) and the Researcher takes it on.
            </p>
          ) : (
            <ul className="space-y-2">
              {tasks.map((task) => (
                <li key={task.id}>
                  <Link href={`/tasks/${task.number}`} className="block border border-line bg-raised px-3 py-2 hover:border-muted">
                    <p className="label mb-0.5 flex justify-between gap-3">
                      <span>
                        #{task.number} · {STATUS_WORDS[task.status]}
                      </span>
                      <When date={new Date(task.updatedAt).toISOString()} />
                    </p>
                    <p className="text-sm">{task.title}</p>
                    {task.summary && <p className="mt-0.5 text-xs text-muted">{task.summary}</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  );
}
