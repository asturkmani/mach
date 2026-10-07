import { PageHeader } from "@/components/page-header";
import { OnboardingNote } from "@/components/onboarding-note";
import { TaskList, type Section } from "@/components/task-list";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { listInbox } from "@/lib/tasks";

export default async function InboxPage() {
  const { organization, person } = await requireAppContext();
  const tasks = (await listInbox(organization.id, person.id)).map((t) => toView(t));
  const urgent = tasks.filter((t) => t.priority === "urgent");
  const rest = tasks.filter((t) => t.priority !== "urgent");
  const sections: Section[] = urgent.length
    ? [
        { title: "Urgent", tasks: urgent },
        { title: "Everything else", tasks: rest },
      ]
    : [{ title: null, tasks: rest }];

  return (
    <>
      <PageHeader title="Inbox" count={tasks.length} />
      {!organization.onboardingCompletedAt && <OnboardingNote />}
      <TaskList
        sections={sections}
        empty={
          <div className="max-w-sm space-y-2 text-center">
            <p className="text-[17px]">Nothing needs you.</p>
            <p className="text-sm text-muted">
              Work comes back here when an agent finishes or needs a decision. Press <kbd className="kbd">N</kbd> for a new
              task, or <kbd className="kbd">C</kbd> to ask the Chief of Staff.
            </p>
          </div>
        }
      />
    </>
  );
}
