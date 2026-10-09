import { notFound } from "next/navigation";

import { TaskDetail, type FileView } from "@/components/task-detail";
import { timeIn } from "@/lib/agents/prompts";
import { listAgents } from "@/lib/agents/store";
import { listLibrary, listTaskFiles, uploadsPrefix, type FileVersion } from "@/lib/files";
import { listPeople } from "@/lib/people";
import { getSchedule } from "@/lib/schedules";
import { blobConnected } from "@/lib/storage";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { getTaskByNumber, listInbox, listMessages, markMentionsSeen } from "@/lib/tasks";

const versionView = (v: FileVersion) => ({
  id: v.id,
  version: v.version,
  size: v.size,
  contentType: v.contentType,
  taskNumber: v.taskNumber,
  agentName: v.agentName,
  basedOn: v.basedOn,
  note: v.note,
  createdAt: new Date(v.createdAt).toISOString(),
});

export default async function TaskPage({ params, searchParams }: PageProps<"/tasks/[number]">) {
  const { organization, person, isAdmin } = await requireAppContext();
  const { number } = await params;
  const task = await getTaskByNumber(organization.id, Number(number), { viewer: person.id });
  if (!task) notFound();
  // Opening the task answers any @-mention of this person on it.
  await markMentionsSeen(task.id, person.id);

  const [messages, taskFiles, library, people, agents, inbox, schedule] = await Promise.all([
    listMessages(task.id),
    listTaskFiles(organization.id, task.id),
    listLibrary(organization.id),
    listPeople(organization.id),
    listAgents(organization.id),
    listInbox(organization.id, person.id),
    getSchedule(task.id),
  ]);
  // After answering, the next row in the inbox opens, like moving down the list.
  const position = inbox.findIndex((t) => t.id === task.id);
  const next = inbox.filter((t) => t.id !== task.id)[Math.max(0, position)] ?? null;
  const reply = (await searchParams).reply === "1";

  // Previews load when someone opens a file (see /files/[versionId]/preview).
  const files: FileView[] = taskFiles.map((file) => ({
    id: file.id,
    name: file.name,
    kind: file.kind,
    role: file.role,
    versions: file.versions.map(versionView),
  }));

  return (
    <TaskDetail
      key={task.id}
      task={{
        ...toView(task),
        description: task.description,
        context: task.context,
        progress: task.progress,
        memory: task.memory,
        archived: Boolean(task.archivedAt),
        hasSandbox: Boolean(task.sandboxName),
        visibility: task.visibility,
        canShare: task.createdByPersonId === person.id || isAdmin,
        schedule: schedule && {
          cron: schedule.cron,
          timezone: schedule.timezone,
          mode: schedule.mode,
          paused: schedule.paused,
          description: schedule.description,
          nextRun: schedule.nextRunAt ? timeIn(schedule.nextRunAt, schedule.timezone) : null,
        },
        canRerun: taskFiles.some((f) => f.kind === "code" && f.name === "run.sh"),
        timezone: organization.timezone,
        createdAt: new Date(task.createdAt).toISOString(),
        members: task.members,
      }}
      messages={messages.map((m) => ({ ...m, createdAt: new Date(m.createdAt).toISOString() }))}
      files={files}
      library={library
        .filter((f) => f.kind === "deliverable" && !taskFiles.some((t) => t.id === f.id))
        .map((f) => ({ id: f.id, name: f.name, version: f.versions[0]?.version ?? 1, taskNumber: f.versions[0]?.taskNumber ?? null }))}
      people={people.map((p) => ({ id: p.id, name: p.name, role: p.role }))}
      agents={agents.filter((a) => a.kind === "defined" && a.status === "active").map((a) => ({ id: a.id, name: a.name, role: a.role }))}
      nextNumber={next?.number ?? null}
      focusReply={reply}
      uploadPrefix={uploadsPrefix(organization.id)}
      canAttach={blobConnected()}
    />
  );
}
