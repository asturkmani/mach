"use client";

import { Archive, ArchiveRestore, ArrowLeft, LoaderCircle, Play, Repeat, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  addMemberAction,
  approveOrDoneAction,
  archiveAction,
  pickOptionAction,
  removeMemberAction,
  replyAction,
  restoreAction,
  runAgentAction,
  setPriorityAction,
  setStatusAction,
  unarchiveAction,
  updateTaskTextAction,
} from "@/app/(app)/tasks/actions";
import { CodeSection, FilesSection, type FileView, type LibraryOption } from "@/components/task-files";
import { RepeatsPanel, type ScheduleView } from "@/components/task-schedule";
import { useCommands, useKeys, useShell } from "@/components/shell/shell";
import { Face, PriorityMark, useStoredFlag, When } from "@/components/ui";
import { byline, type TaskView } from "@/lib/task-view";
import { PRIORITIES, PRIORITY_WORDS, STATUS_WORDS, TASK_STATUSES, type Priority, type TaskStatus } from "@/lib/task-words";
import type { TaskMember, TaskMessageKind } from "@/lib/tasks";

type Detail = TaskView & {
  description: string;
  context: string;
  progress: string;
  memory: string;
  archived: boolean;
  hasSandbox: boolean;
  schedule: ScheduleView | null;
  /** The job has a run.sh that "Run script again" can replay. */
  canRerun: boolean;
  timezone: string | null;
  createdAt: string;
  members: TaskMember[];
};

export type { FileView };
type Message = { id: string; author: string; personId: string | null; agentId: string | null; kind: TaskMessageKind; body: string; createdAt: string };
type Option = { id: string; name: string; role: string };

const SUMMARY_KEY = "mach-summary-open";

export function TaskDetail({
  task,
  messages,
  files,
  library,
  people,
  agents,
  nextNumber,
  focusReply,
}: {
  task: Detail;
  messages: Message[];
  files: FileView[];
  library: LibraryOption[];
  people: Option[];
  agents: Option[];
  nextNumber: number | null;
  focusReply: boolean;
}) {
  const router = useRouter();
  const { openLater, pushUndo, toast } = useShell();
  const [pending, start] = useTransition();
  const [reply, setReply] = useState("");
  const [summaryOpen, setSummaryOpen] = useStoredFlag(SUMMARY_KEY, true);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const closed = task.status === "done" || task.status === "cancelled" || task.archived;
  const lastResult = [...messages].reverse().find((m) => m.kind === "result" || m.kind === "ask");

  const goNext = () => router.push(nextNumber ? `/tasks/${nextNumber}` : "/");

  const act = (work: () => Promise<{ error?: string }>, after?: () => void) =>
    start(async () => {
      const result = await work();
      if (result.error) return toast(result.error);
      after?.();
    });

  const pick = (n: number) => {
    const option = task.options[n];
    if (!option) return;
    act(
      () => pickOptionAction(task.id, n),
      () => {
        toast(`${option.label}${task.kind === "suggestion" ? "" : `: sent to ${byline(task)}`}`);
        goNext();
      },
    );
  };

  const approve = () =>
    start(async () => {
      const result = await approveOrDoneAction(task.id);
      if (result.error) return toast(result.error);
      const previous = result.snapshot;
      if (previous) pushUndo(`Marked #${task.number} done`, async () => void (await restoreAction(task.id, previous)));
      goNext();
    });

  const setStatus = (status: TaskStatus) =>
    start(async () => {
      const result = await setStatusAction(task.id, status);
      if (result.error) return toast(result.error);
      const previous = result.snapshot;
      if (previous) pushUndo(`Moved #${task.number} to ${STATUS_WORDS[status]}`, async () => void (await restoreAction(task.id, previous)));
    });

  const setPriority = (priority: Priority) =>
    start(async () => {
      const result = await setPriorityAction(task.id, priority);
      if (result.error) return toast(result.error);
      const previous = result.snapshot;
      if (previous) pushUndo(`Priority ${PRIORITY_WORDS[priority].toLowerCase()}`, async () => void (await restoreAction(task.id, previous)));
    });

  const archive = (on: boolean) => {
    if (on && task.hasSandbox && !confirm("Archive this job? Its sandbox is deleted; its files stay in the library.")) return;
    act(
      () => (on ? archiveAction(task.id) : unarchiveAction(task.id)),
      () => {
        toast(on ? `Archived #${task.number}` : `Brought back #${task.number}`);
        if (on) goNext();
      },
    );
  };

  const sendReply = () => {
    const text = reply.trim();
    if (!text) return;
    act(
      () => replyAction(task.id, text),
      () => setReply(""),
    );
  };

  const toggleSummary = () => setSummaryOpen(!summaryOpen);

  useKeys({
    escape: () => router.push("/"),
    e: approve,
    r: () => replyRef.current?.focus(),
    l: () => openLater(task.id),
    s: toggleSummary,
    "1": () => pick(0),
    "2": () => pick(1),
    "3": () => pick(2),
  });

  const group = `#${task.number} ${task.title}`;
  useCommands([
    ...PRIORITIES.map((p) => ({
      id: `priority-${p}`,
      group,
      label: `Priority: ${PRIORITY_WORDS[p]}${task.priority === p ? " (current)" : ""}`,
      run: () => setPriority(p),
    })),
    ...TASK_STATUSES.map((s) => ({
      id: `status-${s}`,
      group,
      label: `Move to ${STATUS_WORDS[s]}${task.status === s ? " (current)" : ""}`,
      run: () => setStatus(s),
    })),
    { id: "later", group, label: "Later…", keys: ["L"], run: () => openLater(task.id) },
    { id: "summary", group, label: summaryOpen ? "Hide summary" : "Show summary", keys: ["S"], run: toggleSummary },
    task.archived
      ? { id: "unarchive", group, label: "Bring back from the archive", run: () => archive(false) }
      : { id: "archive", group, label: "Archive this job", run: () => archive(true) },
  ]);

  const agentMembers = task.members.filter((m): m is Extract<TaskMember, { type: "agent" }> => m.type === "agent");
  const personMembers = task.members.filter((m) => m.type === "person");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted hover:text-ink" title="Back (Esc)">
            <ArrowLeft size={16} />
            <span className="label">Inbox</span>
          </Link>
          <span className="label text-faint">/</span>
          <span className="label">#{task.number}</span>
          {task.kind === "suggestion" && <span className="label text-accent">Profile suggestion</span>}
          {task.archived && <span className="label text-faint">Archived</span>}
          {task.schedule && (
            <span className="label flex items-center gap-1 text-faint" title={task.schedule.description}>
              <Repeat size={11} /> {task.schedule.paused ? "Repeats (paused)" : "Repeats"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {task.kind === "task" && (
            <button
              onClick={() => archive(!task.archived)}
              className="btn btn-ghost"
              disabled={pending || task.running}
              title={task.archived ? "Bring this job back" : "Retire this job: deletes its sandbox, keeps its files"}
            >
              {task.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {task.archived ? "Unarchive" : "Archive"}
            </button>
          )}
          <button onClick={() => openLater(task.id)} className="btn btn-ghost" disabled={closed}>
            Later <kbd className="kbd">L</kbd>
          </button>
          <button onClick={approve} className="btn" disabled={pending || task.status === "done"}>
            {task.options.some((o) => o.recommended) ? "Approve" : "Done"} <kbd className="kbd">E</kbd>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-quiet min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 pb-10 pt-8">
            {task.running && (
              <div className="mb-6 flex items-center gap-2 border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
                <LoaderCircle size={14} className="spin-slow text-accent" />
                {task.runAgent ?? "An agent"} is working on this. It comes back to your inbox when it&apos;s done.
              </div>
            )}

            <p className="label mb-3 flex items-center gap-2">
              <span>{byline(task)}</span>
              {lastResult && (
                <>
                  <span className="text-faint">·</span>
                  <span>
                    {lastResult.kind === "ask" ? "Asked" : "Came back"} <When date={lastResult.createdAt} />
                  </span>
                </>
              )}
              <span className="text-faint">·</span>
              <span>{STATUS_WORDS[task.status]}</span>
            </p>
            <EditableTitle task={task} />
            {task.summary && <p className="mt-3 text-[17px] leading-relaxed text-muted">{task.summary}</p>}

            {task.options.length > 0 && !closed && (
              <div className="mt-6 border border-line">
                {task.options.map((option, n) => (
                  <button
                    key={option.label}
                    onClick={() => pick(n)}
                    disabled={pending}
                    className="flex w-full items-center gap-4 border-b border-line-soft px-4 py-3 text-left last:border-b-0 hover:bg-hover"
                  >
                    <kbd className="kbd">{n + 1}</kbd>
                    <span className="flex-1 text-[15px]">{option.label}</span>
                    {option.recommended && <span className="label text-accent">Recommended</span>}
                  </button>
                ))}
              </div>
            )}

            {summaryOpen ? (
              <SummaryCard task={task} onHide={toggleSummary} />
            ) : (
              <button onClick={toggleSummary} className="label mt-6 hover:text-ink">
                Show summary <kbd className="kbd">S</kbd>
              </button>
            )}

            {task.description && (
              <section className="mt-8">
                <p className="label mb-2">The ask</p>
                <div className="prose prose-mach max-w-none text-[15px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown>
                </div>
              </section>
            )}

            <FilesSection taskId={task.id} taskNumber={task.number} files={files} library={library} />
            <CodeSection files={files} notes={task.memory} />

            <section className="mt-10">
              <p className="label mb-4">Thread</p>
              <ol className="space-y-5">
                {messages.map((message) => (
                  <ThreadMessage key={message.id} message={message} />
                ))}
              </ol>
            </section>

            {task.kind === "task" && (
              <form
                className="mt-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendReply();
                }}
              >
                <div className="border border-line bg-raised focus-within:border-muted">
                  <textarea
                    ref={replyRef}
                    autoFocus={focusReply}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    rows={3}
                    placeholder={
                      agentMembers.length
                        ? `Reply to ${agentMembers.map((a) => a.name).join(", ")}… (@name to pick an agent)`
                        : "Write a comment…"
                    }
                    className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-faint"
                  />
                  <div className="flex items-center justify-between border-t border-line-soft px-3 py-2">
                    <span className="text-xs text-faint">
                      <kbd className="kbd">R</kbd> to reply · <kbd className="kbd">⌘↵</kbd> to send
                    </span>
                    <button type="submit" disabled={pending || !reply.trim()} className="btn btn-primary">
                      Send
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>

        <aside className="scroll-quiet hidden w-72 shrink-0 space-y-7 overflow-y-auto border-l border-line px-5 py-7 md:block">
          <Property label="Status">
            <select
              value={task.status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="field py-1.5"
              disabled={pending}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          </Property>
          <Property label="Priority">
            <div className="flex items-center gap-2">
              <PriorityMark priority={task.priority} />
              <select
                value={task.priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className="field py-1.5"
                disabled={pending}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_WORDS[p]}
                  </option>
                ))}
              </select>
            </div>
          </Property>
          {task.kind === "task" && (
            <Property label="Repeats">
              <RepeatsPanel
                taskId={task.id}
                schedule={task.schedule}
                canRerun={task.canRerun}
                busy={task.running || task.archived}
                defaultTimezone={task.timezone}
              />
            </Property>
          )}
          {task.laterUntil && (
            <Property label="Later">
              <p className="text-sm">
                Until <When date={task.laterUntil} />
              </p>
            </Property>
          )}

          <Property label="People">
            <ul className="space-y-2">
              {personMembers.map((m) => (
                <li key={m.id} className="group flex items-center gap-2 text-sm">
                  <Face name={m.name} size={20} />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <RemoveButton onClick={() => act(() => removeMemberAction(task.id, { personId: m.id }))} />
                </li>
              ))}
            </ul>
            <AddSelect
              placeholder="Add a person…"
              options={people.filter((p) => !task.members.some((m) => m.id === p.id))}
              onPick={(id) => act(() => addMemberAction(task.id, { personId: id }))}
            />
          </Property>

          <Property label="Agents">
            <ul className="space-y-2">
              {agentMembers.map((m) => (
                <li key={m.id} className="group flex items-center gap-2 text-sm">
                  <Face name={m.name} agent size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.name}</span>
                    <span className="label text-[10px] text-faint">{m.kind === "worker" ? "Worker" : m.role || "Agent"}</span>
                  </span>
                  {!closed && !task.running && (
                    <button
                      title="Run now"
                      onClick={() => act(() => runAgentAction(task.id, m.id), () => toast(`${m.name} is starting`))}
                      className="text-faint hover:text-accent"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  <RemoveButton onClick={() => act(() => removeMemberAction(task.id, { agentId: m.id }))} />
                </li>
              ))}
            </ul>
            <AddSelect
              placeholder="Add an agent…"
              options={agents.filter((a) => !task.members.some((m) => m.id === a.id))}
              extra={{ id: "__worker", name: "New worker agent…" }}
              onPick={(id) => {
                if (id === "__worker") {
                  const role = prompt("What should the worker do? e.g. Financial analysis", "");
                  if (role === null) return;
                  act(() => addMemberAction(task.id, { workerRole: role }));
                } else {
                  act(() => addMemberAction(task.id, { agentId: id }));
                }
              }}
            />
          </Property>

          <Property label="Created">
            <p className="text-sm text-muted">
              <When date={task.createdAt} />
            </p>
          </Property>
        </aside>
      </div>
    </div>
  );
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="label">{label}</p>
      {children}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Take off this task" className="text-faint opacity-0 hover:text-danger group-hover:opacity-100">
      <X size={13} />
    </button>
  );
}

function AddSelect({
  placeholder,
  options,
  extra,
  onPick,
}: {
  placeholder: string;
  options: { id: string; name: string }[];
  extra?: { id: string; name: string };
  onPick: (id: string) => void;
}) {
  if (options.length === 0 && !extra) return null;
  return (
    <select
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="mt-1 w-full bg-transparent py-1 text-sm text-faint outline-none hover:text-ink"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      {extra && <option value={extra.id}>{extra.name}</option>}
    </select>
  );
}

function EditableTitle({ task }: { task: Detail }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const [, start] = useTransition();
  const save = () => {
    setEditing(false);
    if (value.trim() && value !== task.title) start(async () => void (await updateTaskTextAction(task.id, { title: value })));
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(task.title);
            setEditing(false);
          }
        }}
        className="w-full bg-transparent text-[28px] leading-tight tracking-tight outline-none"
      />
    );
  }
  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`cursor-text text-[28px] leading-tight tracking-tight ${task.priority === "urgent" ? "urgent-title" : ""}`}
    >
      {task.title}
    </h1>
  );
}

/** Context and Done: the few lines that bring a task back to anyone who forgot it. Click a line to edit. */
function SummaryCard({ task, onHide }: { task: Detail; onHide: () => void }) {
  const steps = task.progress.split("\n").map((s) => s.trim()).filter(Boolean);
  return (
    <section className="mt-8 border border-line bg-raised">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
        <p className="label">Summary</p>
        <button onClick={onHide} className="label text-faint hover:text-ink">
          Hide <kbd className="kbd">S</kbd>
        </button>
      </div>
      <div className="grid gap-5 px-4 py-4 sm:grid-cols-2">
        <EditableBlock
          label="Context"
          value={task.context}
          empty="No context yet."
          onSave={(context) => updateTaskTextAction(task.id, { context })}
        />
        <EditableBlock
          label="Done"
          value={task.progress}
          empty="Nothing yet."
          onSave={(progress) => updateTaskTextAction(task.id, { progress })}
          render={() => (
            <ol className="space-y-1 text-sm">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-ok">✓</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}
        />
      </div>
    </section>
  );
}

function EditableBlock({
  label,
  value,
  empty,
  onSave,
  render,
}: {
  label: string;
  value: string;
  empty: string;
  onSave: (value: string) => Promise<unknown>;
  render?: () => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [, start] = useTransition();
  const save = () => {
    setEditing(false);
    if (draft !== value) start(async () => void (await onSave(draft)));
  };
  return (
    <div>
      <p className="label mb-1.5 text-faint">{label}</p>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
          rows={4}
          className="field resize-y text-sm"
        />
      ) : (
        <button onClick={() => setEditing(true)} className="block w-full text-left hover:bg-hover" title="Click to edit">
          {value.trim() ? (render ? render() : <p className="text-sm leading-relaxed">{value}</p>) : <p className="text-sm text-faint">{empty}</p>}
        </button>
      )}
    </div>
  );
}

const KIND_LABEL: Partial<Record<TaskMessageKind, string>> = { ask: "Asked", result: "Result", update: "Update" };

function ThreadMessage({ message }: { message: Message }) {
  if (message.kind === "event") {
    return (
      <li className="flex items-center gap-2 pl-9 text-xs text-faint">
        <span>{message.author}</span>
        <span>{message.body}</span>
        <span>·</span>
        <When date={message.createdAt} />
      </li>
    );
  }
  const isAgent = Boolean(message.agentId) || (!message.personId && message.author === "Chief of Staff");
  return (
    <li className="flex gap-3">
      <Face name={message.author} agent={isAgent} size={26} />
      <div className="min-w-0 flex-1">
        <p className="mb-1 flex items-center gap-2 text-sm">
          <span>{message.author}</span>
          {KIND_LABEL[message.kind] && (
            <span className={`label text-[10px] ${message.kind === "ask" ? "text-accent" : ""}`}>{KIND_LABEL[message.kind]}</span>
          )}
          <span className="text-xs text-faint">
            <When date={message.createdAt} />
          </span>
        </p>
        <div
          className={`prose prose-mach max-w-none text-[15px] ${
            message.kind === "result" ? "border-l-2 border-accent/60 pl-4" : ""
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
        </div>
      </div>
    </li>
  );
}
