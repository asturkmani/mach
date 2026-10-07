import { notFound } from "next/navigation";

import { TaskDetail } from "@/components/task-detail";
import { listAgents } from "@/lib/agents/store";
import { listPeople } from "@/lib/people";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { getTaskByNumber, listInbox, listMessages, listOutputs } from "@/lib/tasks";

export default async function TaskPage({ params, searchParams }: PageProps<"/tasks/[number]">) {
  const { organization, person } = await requireAppContext();
  const { number } = await params;
  const task = await getTaskByNumber(organization.id, Number(number));
  if (!task) notFound();

  const [messages, outputs, people, agents, inbox] = await Promise.all([
    listMessages(task.id),
    listOutputs(task.id),
    listPeople(organization.id),
    listAgents(organization.id),
    listInbox(organization.id, person.id),
  ]);
  // After answering, the next row in the inbox opens, like moving down the list.
  const position = inbox.findIndex((t) => t.id === task.id);
  const next = inbox.filter((t) => t.id !== task.id)[Math.max(0, position)] ?? null;
  const reply = (await searchParams).reply === "1";

  return (
    <TaskDetail
      key={task.id}
      task={{
        ...toView(task),
        description: task.description,
        context: task.context,
        progress: task.progress,
        createdAt: new Date(task.createdAt).toISOString(),
        members: task.members,
      }}
      messages={messages.map((m) => ({ ...m, createdAt: new Date(m.createdAt).toISOString() }))}
      outputs={outputs.map((o) => ({ id: o.id, filename: o.filename, content: o.content, updatedAt: new Date(o.updatedAt).toISOString() }))}
      people={people.map((p) => ({ id: p.id, name: p.name, role: p.role }))}
      agents={agents.filter((a) => a.kind === "defined" && a.status === "active").map((a) => ({ id: a.id, name: a.name, role: a.role }))}
      nextNumber={next?.number ?? null}
      focusReply={reply}
    />
  );
}
