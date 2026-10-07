import { PageHeader } from "@/components/page-header";
import { TaskList, type Section } from "@/components/task-list";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { listInProgress } from "@/lib/tasks";

export default async function InProgressPage() {
  const { organization, person } = await requireAppContext();
  const tasks = (await listInProgress(organization.id, person.id)).map((t) => toView(t));
  const later = tasks.filter((t) => t.laterUntil && t.status !== "backlog");
  const working = tasks.filter((t) => !later.includes(t) && t.status !== "backlog");
  const backlog = tasks.filter((t) => t.status === "backlog");
  const sections: Section[] = [
    { title: "Working", tasks: working },
    { title: "Later", tasks: later },
    { title: "Backlog", tasks: backlog },
  ];

  return (
    <>
      <PageHeader title="In progress" count={tasks.length} />
      <TaskList
        sections={sections}
        showStatus
        empty={
          <div className="max-w-sm space-y-2 text-center">
            <p className="text-[17px]">Nothing in progress.</p>
            <p className="text-sm text-muted">Tasks agents are working on, and ones you put off, wait here.</p>
          </div>
        }
      />
    </>
  );
}
