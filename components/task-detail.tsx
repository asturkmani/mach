"use client";

import { Archive, ArchiveRestore, ArrowLeft, Paperclip, Play, Repeat, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  addMemberAction,
  approveOrDoneAction,
  archiveAction,
  pickOptionAction,
  removeMemberAction,
  replyAction,
  sendQueuedNowAction,
  restoreAction,
  runAgentAction,
  setPriorityAction,
  setStatusAction,
  unarchiveAction,
  updateTaskTextAction,
} from "@/app/(app)/tasks/actions";
import { celebrateDone } from "@/components/shell/flyby";
import { CodeSection, FilesSection, type FileView, type LibraryOption } from "@/components/task-files";
import { MentionTextarea, type MentionCandidate } from "@/components/mention-textarea";
import { Elapsed, formatElapsed, Reactions, Sweep, ThreadStatus, type ReactionView } from "@/components/agent-status";
import { MessageAttachments, PendingAttachments, useReplyAttachments, type MessageAttachmentView } from "@/components/reply-attachments";
import { RepeatsPanel, type ScheduleView } from "@/components/task-schedule";
import { appendDictation, VoiceButton } from "@/components/voice-input";
import { linkMentions } from "@/lib/mentions";
import { useCommands, useKeys, useShell } from "@/components/shell/shell";
import { Face, PriorityMark, useStoredFlag, When } from "@/components/ui";
import { CosToggle } from "@/components/shell/cos-toggle";
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
type Message = {
  id: string;
  author: string;
  personId: string | null;
  agentId: string | null;
  kind: TaskMessageKind;
  body: string;
  createdAt: string;
  /** How long the run took, on an agent's result. */
  durationMs: number | null;
  attachments: MessageAttachmentView[];
  reactions: ReactionView[];
};
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
  uploadPrefix,
  canAttach,
}: {
  task: Detail;
  messages: Message[];
  files: FileView[];
  library: LibraryOption[];
  people: Option[];
  agents: Option[];
  nextNumber: number | null;
  focusReply: boolean;
  /** Where this company's thread attachments upload to, and whether they can (a Blob store is connected). */
  uploadPrefix: string;
  canAttach: boolean;
}) {
  const router = useRouter();
  const { openLater, pushUndo, toast } = useShell();
  const [pending, start] = useTransition();
  const [reply, setReply] = useState("");
  const [summaryOpen, setSummaryOpen] = useStoredFlag(SUMMARY_KEY, true);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const starting = useStarting(task);
  const filePicker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const attachments = useReplyAttachments({ prefix: uploadPrefix, enabled: canAttach, onError: (message) => toast(message) });
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
        toast(`${option.label}${task.kind !== "task" ? "" : `: sent to ${byline(task)}`}`);
        goNext();
      },
    );
  };

  const approve = () =>
    start(async () => {
      const result = await approveOrDoneAction(task.id);
      if (result.error) return toast(result.error);
      const previous = result.snapshot;
      if (previous) celebrateDone();
      if (previous) pushUndo(`Marked #${task.number} done`, async () => void (await restoreAction(task.id, previous)));
      goNext();
    });

  const setStatus = (status: TaskStatus) =>
    start(async () => {
      const result = await setStatusAction(task.id, status);
      if (result.error) return toast(result.error);
      if (status === "done") celebrateDone();
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

  const canSend = !pending && !attachments.uploading && !attachments.failed && Boolean(reply.trim() || attachments.uploads.length);
  // While an agent works, a reply waits for it to finish what it's doing (queued, ⏳); Send now on the
  // queued reply stops it at its next step and starts it again with the reply.
  const sendReply = () => {
    if (!canSend) {
      if (attachments.uploading) toast("Still uploading…");
      else if (attachments.failed) toast("Remove the attachment that failed, then send.");
      return;
    }
    const text = reply.trim();
    const uploads = attachments.uploads;
    act(
      () => replyAction(task.id, text, uploads),
      () => {
        setReply("");
        attachments.clear();
      },
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
  // Who's on it: the agent running, else the one that picked up the latest reply (👀), else the first on the task.
  const lastAsk = [...messages].reverse().find((m) => m.personId && m.kind === "comment");
  const working = task.runAgent ?? lastAsk?.reactions.find((r) => r.emoji === "👀")?.agentName ?? agentMembers[0]?.name ?? null;
  const personMembers = task.members.filter((m) => m.type === "person");
  // Everyone who can be @-mentioned: the company's people and agents, plus agents made for this task.
  const mentionable: MentionCandidate[] = [
    ...people.map((p) => ({ id: p.id, name: p.name, kind: "person" as const, detail: p.role })),
    ...agents.map((a) => ({ id: a.id, name: a.name, kind: "agent" as const, detail: a.role })),
    ...agentMembers.filter((m) => !agents.some((a) => a.id === m.id)).map((m) => ({ id: m.id, name: m.name, kind: "agent" as const, detail: "Worker" })),
  ];
  const mentionNames = mentionable.map((m) => m.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5 sm:gap-4 sm:px-6 sm:py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted hover:text-ink" title="Back (Esc)">
            <ArrowLeft size={16} />
            <span className="label">Home</span>
          </Link>
          <span className="label text-faint">/</span>
          <span className="label">#{task.number}</span>
          {task.kind === "suggestion" && <span className="label text-accent-ink">Profile suggestion</span>}
          {task.kind === "join_request" && <span className="label text-accent-ink">Asking to join</span>}
          {task.archived && <span className="label text-faint">Archived</span>}
          {task.schedule && (
            <span className="label flex items-center gap-1 text-faint" title={task.schedule.description}>
              <Repeat size={11} /> <span className="hidden sm:inline">{task.schedule.paused ? "Repeats (paused)" : "Repeats"}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {task.kind === "task" && (
            <button
              onClick={() => archive(!task.archived)}
              className="btn btn-ghost"
              disabled={pending || task.running}
              title={task.archived ? "Bring this job back" : "Retire this job: deletes its sandbox, keeps its files"}
            >
              {task.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              <span className="hidden sm:inline">{task.archived ? "Unarchive" : "Archive"}</span>
            </button>
          )}
          <button onClick={() => openLater(task.id)} className="btn btn-ghost" disabled={closed}>
            Later <kbd className="kbd hidden md:inline-flex">L</kbd>
          </button>
          <button onClick={approve} className="btn" disabled={pending || task.status === "done"}>
            {task.options.some((o) => o.recommended) ? "Approve" : "Done"} <kbd className="kbd hidden md:inline-flex">E</kbd>
          </button>
          <CosToggle />
        </div>
      </header>

      {/* On a phone the details come after the thread, in one scroll. */}
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="scroll-quiet min-w-0 md:flex-1 md:overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 pt-6 pb-10 sm:px-8 sm:pt-8">
            {task.running && (
              <div
                className="relative mb-6 flex items-center gap-2 border border-accent/40 bg-accent-soft px-3 py-2 text-sm"
                title="It comes back to the top of Home when it's done."
              >
                <span className="shrink-0">{task.runAgent ?? "An agent"} is working</span>
                {task.activity && <span className="min-w-0 truncate text-muted">· {task.activity}</span>}
                <Elapsed since={task.runSince} className="ml-auto shrink-0" />
                <Sweep />
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
                    {option.recommended && <span className="label text-accent-ink">Recommended</span>}
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
                  <ThreadMessage
                    key={message.id}
                    message={message}
                    names={mentionNames}
                    onSendNow={task.running ? () => act(() => sendQueuedNowAction(task.id, message.id)) : undefined}
                  />
                ))}
                {(task.running || starting) && (
                  <ThreadStatus agent={working ?? "An agent"} activity={task.activity} since={task.runSince} starting={!task.running} />
                )}
              </ol>
            </section>

            {task.kind === "task" && (
              <form
                className="mt-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendReply();
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.files.length) return;
                  e.preventDefault();
                  setDragging(false);
                  attachments.add(Array.from(e.dataTransfer.files));
                }}
              >
                <div className={`border bg-raised focus-within:border-muted ${dragging ? "border-accent" : "border-line"}`}>
                  <MentionTextarea
                    ref={replyRef}
                    autoFocus={focusReply}
                    value={reply}
                    onValueChange={setReply}
                    candidates={mentionable}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    onPaste={(e) => {
                      // A pasted screenshot attaches; pasted text (even with an image alongside, as from Excel) stays text.
                      const files = Array.from(e.clipboardData.files);
                      if (!files.length || e.clipboardData.types.includes("text/plain")) return;
                      e.preventDefault();
                      attachments.add(files);
                    }}
                    rows={3}
                    placeholder={
                      agentMembers.length
                          ? `Reply to ${agentMembers.map((a) => a.name).join(", ")}… (@ to mention someone)`
                          : "Write a comment… (@ to mention someone)"
                    }
                    className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-faint"
                  />
                  <PendingAttachments pending={attachments.pending} onRemove={attachments.remove} />
                  <div className="flex items-center justify-between border-t border-line-soft px-3 py-2">
                    <div className="flex items-center gap-3">
                      <input
                        ref={filePicker}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          attachments.add(Array.from(e.target.files ?? []));
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => (canAttach ? filePicker.current?.click() : toast("Connect a Vercel Blob store to attach files."))}
                        title={canAttach ? "Attach files (or paste or drop them here)" : "Connect a Vercel Blob store to attach files"}
                        aria-label="Attach files"
                        className={`text-muted hover:text-ink ${canAttach ? "" : "opacity-50"}`}
                      >
                        <Paperclip size={15} />
                      </button>
                      <VoiceButton
                        onText={(text) => {
                          setReply((current) => appendDictation(current, text));
                          replyRef.current?.focus();
                        }}
                        className="text-muted hover:text-ink"
                      />
                      <span className="hidden text-xs text-faint md:inline">
                        <kbd className="kbd">R</kbd> to reply · <kbd className="kbd">⌘↵</kbd> to send
                      </span>
                    </div>
                    <button type="submit" disabled={!canSend} className="btn btn-primary">
                      Send
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>

        <aside className="scroll-quiet w-full shrink-0 space-y-7 border-t border-line px-4 py-7 md:w-72 md:overflow-y-auto md:border-t-0 md:border-l md:px-5">
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
    <button onClick={onClick} title="Take off this task" className="text-faint opacity-0 hover:text-danger group-hover:opacity-100 pointer-coarse:opacity-100">
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
        className="w-full bg-transparent text-[28px] leading-tight font-medium tracking-tight outline-none"
      />
    );
  }
  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`cursor-text text-[28px] leading-tight font-medium tracking-tight ${task.priority === "urgent" ? "urgent-title" : ""}`}
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

/** Mentions ("@Name") show as links to "#mention", styled here rather than followed. */
const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    href === "#mention" ? (
      <span className="font-medium text-accent-ink">{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

function ThreadMessage({ message, names, onSendNow }: { message: Message; names: string[]; onSendNow?: () => void }) {
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
            <span className={`label text-[10px] ${message.kind === "ask" ? "text-accent-ink" : ""}`}>{KIND_LABEL[message.kind]}</span>
          )}
          {message.kind === "result" && message.durationMs !== null && (
            <span className="readout">Done in {formatElapsed(Math.max(1, Math.round(message.durationMs / 1000)))}</span>
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {linkMentions(message.body, names)}
          </ReactMarkdown>
        </div>
        <MessageAttachments attachments={message.attachments} />
        <div className="flex flex-wrap items-center gap-2">
          <Reactions reactions={message.reactions} />
          {onSendNow && message.reactions.some((r) => r.emoji === "⏳") && (
            <button onClick={onSendNow} className="mt-1.5 text-xs text-muted underline hover:text-ink" title="Stop what the agent is doing and have it read this now">
              Send now
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** A run is about to start: an agent was just woken (by a reply, or a new task) and hasn't begun. */
function useStarting(task: Pick<Detail, "running" | "status" | "agents" | "updatedAt">): boolean {
  const waiting = !task.running && task.status === "ready" && task.agents.length > 0;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [waiting]);
  // A start that hasn't happened within a few minutes isn't coming; don't promise it.
  return waiting && now !== null && now - new Date(task.updatedAt).getTime() < 3 * 60_000;
}
