import { Board } from "@/components/board";
import { PageHeader } from "@/components/page-header";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { listTasks } from "@/lib/tasks";

export default async function BoardPage() {
  const { organization } = await requireAppContext();
  // Profile suggestions are approvals, not work, so they stay in the inbox only.
  const tasks = (await listTasks(organization.id, { closedLimit: 25 })).filter((t) => t.status !== "cancelled" && t.kind === "task");
  return (
    <>
      <PageHeader title="Board" count={tasks.filter((t) => t.status !== "done").length} />
      <Board tasks={tasks.map((t) => toView(t))} />
    </>
  );
}
