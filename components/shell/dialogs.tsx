"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createTaskAction, laterAction, restoreAction } from "@/app/(app)/tasks/actions";
import { Face } from "@/components/ui";
import { PRIORITIES, PRIORITY_WORDS, type Priority } from "@/lib/task-words";

import { useShell } from "./shell";

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-[10vh]"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`frame enter-drop w-full ${wide ? "max-w-2xl" : "max-w-md"} bg-raised p-6 shadow-[var(--shadow)]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="label">{title}</h2>
          <button onClick={onClose} className="text-faint hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center gap-2 border px-2 py-1 text-sm ${on ? "border-ink bg-selected" : "border-line text-muted hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const { data, toast } = useShell();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [people, setPeople] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [worker, setWorker] = useState(false);
  const [workerRole, setWorkerRole] = useState("");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const others = data.people.filter((p) => p.id !== data.me.personId);

  const submit = () =>
    start(async () => {
      const result = await createTaskAction({
        title,
        description,
        priority,
        personIds: people,
        agentIds: agents,
        workerRole: worker ? workerRole : null,
      });
      if (result.error) return setError(result.error);
      onClose();
      toast(`Created #${result.number}`);
      router.push(`/tasks/${result.number}`);
    });

  return (
    <Dialog title="New task" onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing? e.g. Review Micron's latest earnings"
          className="w-full bg-transparent text-xl outline-none placeholder:text-faint"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Details: the goal, sources to use, what done looks like."
          className="field resize-none"
        />

        <div className="space-y-2">
          <p className="label">People</p>
          <div className="flex flex-wrap gap-2">
            <span className="flex items-center gap-2 border border-line px-2 py-1 text-sm text-muted">
              <Face name={data.me.name} size={18} /> You
            </span>
            {others.map((p) => (
              <Toggle key={p.id} on={people.includes(p.id)} onClick={() => setPeople(flip(people, p.id))}>
                <Face name={p.name} size={18} /> {p.name}
              </Toggle>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="label">Agents</p>
          <div className="flex flex-wrap gap-2">
            {data.agents.map((a) => (
              <Toggle key={a.id} on={agents.includes(a.id)} onClick={() => setAgents(flip(agents, a.id))}>
                <Face name={a.name} agent size={18} /> {a.name}
              </Toggle>
            ))}
            <Toggle on={worker} onClick={() => setWorker(!worker)}>
              <Face name="+" agent size={18} /> Worker agent
            </Toggle>
          </div>
          {worker && (
            <input
              value={workerRole}
              onChange={(e) => setWorkerRole(e.target.value)}
              placeholder="Worker's role, e.g. Financial analysis (optional)"
              className="field"
            />
          )}
          {agents.length === 0 && !worker && (
            <p className="text-xs text-faint">No agent: it goes straight to the people on it.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-1">
            {PRIORITIES.map((p) => (
              <Toggle key={p} on={priority === p} onClick={() => setPriority(p)}>
                {PRIORITY_WORDS[p]}
              </Toggle>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {error && <p className="text-sm text-danger">{error}</p>}
            <button type="submit" disabled={pending || !title.trim()} className="btn btn-primary">
              {pending ? "Creating…" : "Create task"} <kbd className="kbd">⌘↵</kbd>
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function laterChoices(now = new Date()) {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { key: "1", label: "Later today", when: new Date(now.getTime() + 3 * 3_600_000) },
    { key: "2", label: "Tomorrow morning", when: at(1, 9) },
    { key: "3", label: "Next week", when: at(daysToMonday, 9) },
  ];
}

export function LaterDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { pushUndo, toast } = useShell();
  const [custom, setCustom] = useState("");
  const [pending, start] = useTransition();
  const choices = laterChoices();

  const choose = (when: Date) =>
    start(async () => {
      const result = await laterAction(taskId, when.toISOString());
      if (result.error) return toast(result.error);
      onClose();
      const previous = result.snapshot;
      const label = `Put off until ${when.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
      if (previous) pushUndo(label, async () => void (await restoreAction(taskId, previous)));
    });

  return (
    <Dialog title="Later" onClose={onClose}>
      <div
        className="space-y-1"
        onKeyDown={(e) => {
          const choice = choices.find((c) => c.key === e.key);
          if (choice && (e.target as HTMLElement).tagName !== "INPUT") {
            e.preventDefault();
            choose(choice.when);
          }
        }}
      >
        {choices.map((choice, i) => (
          <button
            key={choice.key}
            autoFocus={i === 0}
            disabled={pending}
            onClick={() => choose(choice.when)}
            className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-hover focus:bg-hover focus:outline-none"
          >
            <span className="flex items-center gap-3">
              <kbd className="kbd">{choice.key}</kbd> {choice.label}
            </span>
            <span className="label">
              {choice.when.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
            </span>
          </button>
        ))}
        <form
          className="flex gap-2 px-3 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom) choose(new Date(custom));
          }}
        >
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} className="field" />
          <button type="submit" disabled={!custom || pending} className="btn">
            Set
          </button>
        </form>
      </div>
    </Dialog>
  );
}

export const SHORTCUTS: { group: string; keys: string[]; label: string }[] = [
  { group: "Move", keys: ["J", "K"], label: "Move through the list (or ↓ ↑)" },
  { group: "Move", keys: ["Enter"], label: "Open a row" },
  { group: "Move", keys: ["Esc"], label: "Back to the list" },
  { group: "Act", keys: ["E"], label: "Approve the recommendation, or mark done" },
  { group: "Act", keys: ["1", "2", "3"], label: "Pick an option an agent offered" },
  { group: "Act", keys: ["R"], label: "Reply" },
  { group: "Act", keys: ["L"], label: "Later: put a task off until a time you pick" },
  { group: "Act", keys: ["Z"], label: "Undo" },
  { group: "Create", keys: ["N"], label: "New task" },
  { group: "View", keys: ["S"], label: "Show or hide the summary, in an open task" },
  { group: "View", keys: ["C"], label: "Show or hide the Chief of Staff" },
  { group: "View", keys: ["/"], label: "Search tasks" },
  { group: "View", keys: ["⌘", "K"], label: "Everything else" },
  { group: "View", keys: ["?"], label: "These shortcuts" },
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <button autoFocus className="sr-only" onClick={onClose}>
        Close
      </button>
      <table className="w-full text-sm">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.label}>
              <td className="py-1.5 pr-4 align-top">
                <span className="flex gap-1">
                  {s.keys.map((k) => (
                    <kbd key={k} className="kbd">
                      {k}
                    </kbd>
                  ))}
                </span>
              </td>
              <td className="py-1.5 text-muted">{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
