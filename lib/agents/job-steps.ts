import { firstSentence, lastLines, type RunContext } from "@/lib/agents/prompts";
import { knownSkills } from "@/lib/agents/skills";
import { coordinatorAgent, workerAgent } from "@/lib/agents/store";
import { attachToTask, contentTypeFor, isText, listTaskFiles, readVersion } from "@/lib/files";
import { listPeople } from "@/lib/people";
import {
  addMember,
  addMessage,
  agentsOn,
  CLOSED_STATUSES,
  createTask,
  getTask,
  getTaskByNumber,
  inFlight,
  isRunning,
  listChildren,
  listMessages,
  needsAnswer,
  nextBatch,
  removeMember,
  requestInterrupt,
  setBatch,
  updateTask,
  type Task,
} from "@/lib/tasks";

// Jobs (docs/agent-design.md): the coordinator's steps on its job's children,
// and a worker turning its task into a job. Each is a durable step inside the
// agent-run workflow. The dispatcher is loaded, not imported, as it starts
// the workflows that call these.

/** At most this many children in one batch, and in one job. */
export const MAX_BATCH = 8;
export const MAX_CHILDREN = 40;

const by = (context: RunContext) => ({ author: context.agentName, agentId: context.agentId });
const numbers = (tasks: Pick<Task, "number">[]) => tasks.map((t) => `#${t.number}`).join(", ");

async function childOf(context: RunContext, number: number): Promise<Task | string> {
  const task = await getTaskByNumber(context.organizationId, number);
  if (!task || task.parentTaskId !== context.taskId) return `#${number} isn't one of this job's children.`;
  return task;
}

/** The batch the children started in this run belong to. */
export async function batchFor(context: RunContext): Promise<number> {
  "use step";
  return nextBatch(context.taskId);
}

export type ChildInput = {
  assignee: "worker" | "person";
  person?: string;
  title: string;
  brief: string;
  skills?: string[];
  after?: number[];
  files?: string[];
};

/** Starts a child on the job: a task for the Worker with its skills, or for one person. */
export async function startChild(context: RunContext, input: ChildInput, batch: number): Promise<string> {
  "use step";
  const { organizationId } = context;
  const job = await getTask(organizationId, context.taskId);
  if (!job) return "The job no longer exists.";
  const children = await listChildren(organizationId, job.id);
  if (children.filter((c) => c.status !== "done" && c.status !== "cancelled").length >= MAX_CHILDREN) {
    return `Not started: a job has at most ${MAX_CHILDREN} children open. Report what you have, or ask how to go on.`;
  }
  if (children.filter((c) => c.batch === batch).length >= MAX_BATCH) {
    return `Not started: at most ${MAX_BATCH} children in a batch. Wait for these, then start the rest.`;
  }
  const before = (input.after ?? []).map((n) => children.find((c) => c.number === n));
  if (before.some((c) => !c)) return `Not started: after takes this job's children only (${numbers(children) || "none yet"}).`;
  const cancelled = before.filter((c) => c!.status === "cancelled");
  if (cancelled.length) return `Not started: ${numbers(cancelled as Task[])} was cancelled, so it would never start.`;
  let personId: string | undefined;
  if (input.assignee === "person") {
    const everyone = await listPeople(organizationId);
    const person = everyone.find((p) => p.name.toLowerCase() === input.person?.trim().toLowerCase());
    if (!person) return `Not started: name a person on the team (${everyone.map((p) => p.name).join(", ")}).`;
    personId = person.id;
  }
  const waiting = before.some((c) => c!.status !== "review" && c!.status !== "done");
  const worker = input.assignee === "worker" ? await workerAgent(organizationId) : null;
  const task = await createTask(organizationId, {
    title: input.title,
    description: input.brief,
    summary: personId ? firstSentence(input.title) : undefined,
    status: waiting ? "backlog" : "ready",
    // Created for the person the job is for, never by the coordinator: whose accounts a run may use follows from it.
    createdBy: { personId: job.createdByPersonId ?? undefined },
    people: personId ? [personId] : [],
    agents: worker ? [worker.id] : [],
    visibility: job.visibility,
    waitsFor: before.map((c) => c!.id),
    skills: worker ? knownSkills(input.skills) : [],
    parentTaskId: job.id,
    assigneeKind: input.assignee,
    batch,
  });
  const jobFiles = await listTaskFiles(organizationId, job.id);
  const missing: string[] = [];
  for (const name of input.files ?? []) {
    const file = jobFiles.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
    if (file) await attachToTask(organizationId, task.id, file.id, "input");
    else missing.push(name);
  }
  const who = worker ? `the Worker${task.skills.length ? ` with ${task.skills.join(", ")}` : ""}` : input.person!.trim();
  await addMessage(task.id, {
    ...by(context),
    kind: "event",
    body: `Started this for job #${job.number}.${waiting ? ` It starts once ${numbers(before as Task[])} ${before.length > 1 ? "are" : "is"} delivered.` : ""}`,
  });
  await addMessage(job.id, { ...by(context), kind: "event", body: `Started #${task.number} ${task.title}: ${who}.` });
  if (!waiting) {
    // A person hears about theirs from their own assistant, or a notification; the Worker starts now.
    if (personId) await updateTask(organizationId, task.id, { status: "waiting" });
    else {
      const { startIfReady } = await import("@/lib/agents/dispatch");
      await startIfReady(organizationId, task.id);
    }
  }
  return `Started #${task.number} (${who}, batch ${batch})${waiting ? `, waiting for ${numbers(before as Task[])}` : ""}.${
    missing.length ? ` There's no ${missing.join(", ")} on this job, so it starts without it.` : ""
  }`;
}

/** Writes on a child: an answer to its question, or what to redo. It goes back to work in this run's batch. */
export async function messageChild(context: RunContext, input: { child: number; text: string }, batch: number): Promise<string> {
  "use step";
  const child = await childOf(context, input.child);
  if (typeof child === "string") return child;
  if (child.status === "cancelled") return `#${child.number} was cancelled. Start a new child instead.`;
  if (isRunning(child)) return `#${child.number} is working right now. Write to it once it's in.`;
  await addMessage(child.id, { ...by(context), kind: "comment", body: input.text.trim() });
  await setBatch(child.id, batch);
  if (child.assigneeKind === "person") {
    await updateTask(context.organizationId, child.id, { status: "waiting", summary: firstSentence(input.text) });
    return `Sent to ${child.members.find((m) => m.type === "person")?.name ?? "them"} on #${child.number}.`;
  }
  const agent = agentsOn(child).find((a) => a.status === "active");
  if (!agent) return `Nobody is on #${child.number} to pick it up. Start a new child instead.`;
  await updateTask(context.organizationId, child.id, { status: "ready", options: [] });
  const { dispatchRun } = await import("@/lib/agents/dispatch");
  await dispatchRun(context.organizationId, child.id, agent.id);
  return `Sent to #${child.number}; it's working on it again.`;
}

/** Stops a child, and any child that waits for it. */
export async function cancelChild(context: RunContext, input: { child: number; why?: string }): Promise<string> {
  "use step";
  const child = await childOf(context, input.child);
  if (typeof child === "string") return child;
  if (CLOSED_STATUSES.includes(child.status)) return `#${child.number} is already ${child.status}.`;
  const children = await listChildren(context.organizationId, context.taskId);
  // Everything that waits on it, however indirectly, would never start.
  const stopping = new Set([child.number]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of children) {
      if (!stopping.has(c.number) && !CLOSED_STATUSES.includes(c.status) && c.waitsFor.some((n) => stopping.has(n))) {
        stopping.add(c.number);
        grew = true;
      }
    }
  }
  const dependents = children.filter((c) => c.number !== child.number && stopping.has(c.number));
  for (const task of [child, ...dependents]) {
    await requestInterrupt(task.id);
    await updateTask(context.organizationId, task.id, { status: "cancelled", options: [] });
    await addMessage(task.id, { ...by(context), kind: "event", body: `Cancelled this${input.why ? `: ${input.why.trim()}` : "."}` });
  }
  return `Cancelled ${numbers([child, ...dependents])}.`;
}

/** A child's whole result: its latest report or question, and its files (small text ones in full). */
export async function readChild(context: RunContext, input: { child: number }): Promise<string> {
  "use step";
  const child = await childOf(context, input.child);
  if (typeof child === "string") return child;
  const [messages, files] = await Promise.all([listMessages(child.id), listTaskFiles(context.organizationId, child.id)]);
  const latest = messages.findLast((m) => m.kind === "result" || m.kind === "ask");
  const fileLines = await Promise.all(
    files
      .filter((f) => f.versions.length > 0 && f.kind !== "code")
      .map(async (f) => {
        const v = f.versions[0];
        const textual = isText(v.contentType || contentTypeFor(f.name)) && v.size <= 40_000;
        const content = textual ? await readVersion(context.organizationId, v.id) : null;
        return content ? `<file name="${f.name}" version="${v.version}">\n${content.bytes.toString("utf8")}\n</file>` : `- ${f.name} (v${v.version}, ${v.size} bytes)`;
      }),
  );
  return [
    `#${child.number} ${child.title} (${child.assigneeKind}, ${child.status}, batch ${child.batch})`,
    `Summary: ${child.summary || "(none yet)"}`,
    latest ? `Latest ${latest.kind === "ask" ? "question" : "result"} from ${latest.author}:\n${latest.body.slice(0, 20_000)}` : "No result yet.",
    fileLines.length ? `Files:\n${fileLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Puts a child's deliverable on the job, so the job's report carries it. */
export async function collectFile(context: RunContext, input: { child: number; name: string }): Promise<string> {
  "use step";
  const child = await childOf(context, input.child);
  if (typeof child === "string") return child;
  const files = await listTaskFiles(context.organizationId, child.id);
  const file = files.find((f) => f.name.toLowerCase() === input.name.trim().toLowerCase());
  if (!file) return `#${child.number} has no file called ${input.name}. It has: ${files.map((f) => f.name).join(", ") || "none"}.`;
  await attachToTask(context.organizationId, context.taskId, file.id, "output");
  return `${file.name} is on the job now.`;
}

/** Why the coordinator can't end its run yet, if it can't: a child is waiting on it, or nothing is running. */
export async function cantWait(context: RunContext): Promise<string | null> {
  "use step";
  const children = await listChildren(context.organizationId, context.taskId);
  const asking = children.filter(needsAnswer);
  if (asking.length) return `${numbers(asking)} ${asking.length > 1 ? "are" : "is"} waiting on you: answer with message_child, or cancel_child.`;
  if (!children.some(inFlight)) return "Nothing is running. Start children, ask the person something, or finish.";
  return null;
}

/** The coordinator's run ends; it wakes when what it started is in, or a child needs it. */
export async function waitForChildren(context: RunContext, input: { note?: string; progress?: string }): Promise<string> {
  "use step";
  const children = await listChildren(context.organizationId, context.taskId);
  const working = children.filter(inFlight);
  if (input.note?.trim()) await addMessage(context.taskId, { ...by(context), kind: "update", body: input.note.trim() });
  await updateTask(context.organizationId, context.taskId, {
    summary: `Waiting on ${numbers(working)} (${children.filter((c) => c.status === "review" || c.status === "done").length} of ${children.filter((c) => c.status !== "cancelled").length} in).`,
    progress: lastLines(input.progress, 6),
  });
  return "Waiting. Your run ends here; you wake when they're in, or one needs you.";
}

/** Children still running, for finish: the job reports once, at the end. */
export async function stillWorking(context: RunContext): Promise<string | null> {
  "use step";
  const working = (await listChildren(context.organizationId, context.taskId)).filter(inFlight);
  return working.length ? `${numbers(working)} ${working.length > 1 ? "are" : "is"} still working: wait_for_children, or cancel them first.` : null;
}

/** The job reported: its delivered children are done, so a repeating job's next round starts clean. */
export async function closeChildren(context: RunContext): Promise<void> {
  "use step";
  for (const child of await listChildren(context.organizationId, context.taskId)) {
    if (child.status === "review") await updateTask(context.organizationId, child.id, { status: "done" });
  }
}

/** A worker's task becomes a job: the coordinator takes it over, starting from what the worker found. */
export async function escalateTask(context: RunContext, input: { why: string; found: string }): Promise<string> {
  "use step";
  const coordinator = await coordinatorAgent(context.organizationId);
  await addMessage(context.taskId, {
    ...by(context),
    kind: "update",
    body: `This needs a plan, so it's now a job: ${input.why.trim()}\n\nWhat I found so far:\n${input.found.trim()}`,
  });
  await addMember(context.taskId, { agentId: coordinator.id });
  await removeMember(context.taskId, { agentId: context.agentId });
  await updateTask(context.organizationId, context.taskId, { summary: firstSentence(`Planning it as a job: ${input.why}`) });
  await addMessage(context.taskId, { author: "Mach1", kind: "event", body: `${coordinator.name} took this over as a job.` });
  return coordinator.id;
}

/** After a run on a child or a job: wakes the job's coordinator if what it started is in, or a child needs it. */
export async function wakeJobStep(organizationId: string, taskId: string): Promise<void> {
  "use step";
  const { wakeJob } = await import("@/lib/agents/dispatch");
  await wakeJob(organizationId, taskId);
}
