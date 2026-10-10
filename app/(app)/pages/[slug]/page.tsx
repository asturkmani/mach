import { notFound } from "next/navigation";
import { after } from "next/server";

import { PageView } from "@/components/page-view";
import { pageIdeas } from "@/lib/page-ideas";
import { getPage, listPageVersions, pageDataStatus } from "@/lib/pages";
import { getSchedule } from "@/lib/schedules";
import { requireAppContext } from "@/lib/session";
import { getTask } from "@/lib/tasks";

// @map Page | Pages → click a page | One page: the report itself, how fresh its data is, the job that refreshes it, its versions, Private/Company.
// One page: its header (how fresh its data is, the job that refreshes it,
// its versions) over the page itself, in a sandboxed frame. ?v= shows an
// older version.
export default async function PagePage({ params, searchParams }: PageProps<"/pages/[slug]">) {
  const { organization, person, isAdmin } = await requireAppContext();
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = await getPage(organization.id, slug, { viewer: person.id });
  if (!page || page.version === 0) notFound();
  const [files, versions, task, schedule, ideas] = await Promise.all([
    pageDataStatus(organization.id, page),
    listPageVersions(organization.id, slug),
    page.taskId ? getTask(organization.id, page.taskId, { viewer: person.id }) : null,
    page.taskId ? getSchedule(page.taskId) : null,
    // Cached; when out of date the old ones show and new ones are written after the response.
    pageIdeas(organization.id, { later: (work) => after(work), neverWait: true }).catch(() => []),
  ]);
  const asked = Number(query.v);
  const viewing = versions.some((v) => v.version === asked) && asked !== page.version ? asked : null;

  return (
    <PageView
      page={{
        slug: page.slug,
        title: page.title,
        description: page.description,
        version: page.version,
        visibility: page.visibility,
        canShare: page.createdByPersonId === person.id || isAdmin,
      }}
      viewing={viewing}
      files={files.map((f) => ({ path: f.path, live: Boolean(f.live), updatedAt: f.updatedAt?.toISOString() ?? null, problem: f.problem ?? null }))}
      ideas={ideas}
      versions={versions.map((v) => ({ version: v.version, note: v.note, byName: v.byName, createdAt: v.createdAt.toISOString() }))}
      refresh={
        task && !task.archivedAt
          ? {
              number: task.number,
              running: Boolean(task.runStartedAt),
              schedule: schedule && !schedule.paused ? schedule.description : schedule?.paused ? "Paused" : null,
              lastRunAt: schedule?.lastRunAt ? new Date(schedule.lastRunAt).toISOString() : null,
              // A quiet job is left done after each run; anything else means a run failed and someone is on it.
              failing: !task.runStartedAt && task.status !== "done" && task.status !== "backlog",
            }
          : null
      }
    />
  );
}
