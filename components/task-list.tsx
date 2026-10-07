"use client";

import { LoaderCircle, Repeat } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { approveOrDoneAction, pickOptionAction, restoreAction, setPriorityAction } from "@/app/(app)/tasks/actions";
import { KeyHints } from "@/components/page-header";
import { useCommands, useKeys, useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";
import { byline, type TaskView } from "@/lib/task-view";
import { PRIORITIES, PRIORITY_WORDS, STATUS_WORDS } from "@/lib/task-words";

// A keyboard-first list of tasks in sections (Urgent, then everything else).
// J/K move, Enter opens, E approves or marks done, 1-3 pick an option, R
// replies, L puts it off.

export type Section = { title: string | null; tasks: TaskView[] };

export function TaskList({
  sections,
  empty,
  showStatus = false,
}: {
  sections: Section[];
  empty: React.ReactNode;
  showStatus?: boolean;
}) {
  const router = useRouter();
  const { openLater, pushUndo, toast } = useShell();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [, start] = useTransition();

  const visible = useMemo(
    () => sections.map((s) => ({ ...s, tasks: s.tasks.filter((t) => !hidden.has(t.id)) })).filter((s) => s.tasks.length),
    [sections, hidden],
  );
  const flat = useMemo(() => visible.flatMap((s) => s.tasks), [visible]);
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, flat.length - 1));
  const selected = flat[index];

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const hide = (id: string) => setHidden((all) => new Set(all).add(id));
  const unhide = (id: string) =>
    setHidden((all) => {
      const next = new Set(all);
      next.delete(id);
      return next;
    });

  const approve = (task: TaskView) => {
    hide(task.id);
    start(async () => {
      const result = await approveOrDoneAction(task.id);
      if (result.error) {
        unhide(task.id);
        return toast(result.error);
      }
      const previous = result.snapshot;
      if (previous) {
        pushUndo(`Marked #${task.number} done`, async () => {
          unhide(task.id);
          await restoreAction(task.id, previous);
        });
      } else {
        const option = task.options.find((o) => o.recommended);
        toast(option ? `${option.label}: sent to ${byline(task)}` : "Done");
      }
    });
  };

  const pick = (task: TaskView, n: number) => {
    const option = task.options[n];
    if (!option) return;
    hide(task.id);
    start(async () => {
      const result = await pickOptionAction(task.id, n);
      if (result.error) {
        unhide(task.id);
        return toast(result.error);
      }
      toast(`${option.label}${task.kind === "suggestion" ? "" : `: sent to ${byline(task)}`}`);
    });
  };

  const prioritize = (task: TaskView, priority: (typeof PRIORITIES)[number]) =>
    start(async () => {
      const result = await setPriorityAction(task.id, priority);
      if (result.error) return toast(result.error);
      const previous = result.snapshot;
      if (previous) pushUndo(`Priority ${PRIORITY_WORDS[priority].toLowerCase()} on #${task.number}`, async () => void (await restoreAction(task.id, previous)));
    });

  useKeys({
    j: () => setCursor(Math.min(index + 1, flat.length - 1)),
    down: () => setCursor(Math.min(index + 1, flat.length - 1)),
    k: () => setCursor(Math.max(index - 1, 0)),
    up: () => setCursor(Math.max(index - 1, 0)),
    enter: () => selected && router.push(`/tasks/${selected.number}`),
    o: () => selected && router.push(`/tasks/${selected.number}`),
    e: () => selected && approve(selected),
    r: () => selected && router.push(`/tasks/${selected.number}?reply=1`),
    l: () => selected && openLater(selected.id),
    "1": () => selected && pick(selected, 0),
    "2": () => selected && pick(selected, 1),
    "3": () => selected && pick(selected, 2),
  });

  useCommands(
    selected
      ? [
          ...PRIORITIES.map((p) => ({
            id: `priority-${p}`,
            group: `#${selected.number} ${selected.title}`,
            label: `Priority: ${PRIORITY_WORDS[p]}${selected.priority === p ? " (current)" : ""}`,
            run: () => prioritize(selected, p),
          })),
          { id: "done", group: `#${selected.number} ${selected.title}`, label: "Approve or mark done", keys: ["E"], run: () => approve(selected) },
          { id: "later", group: `#${selected.number} ${selected.title}`, label: "Later…", keys: ["L"], run: () => openLater(selected.id) },
        ]
      : [],
  );

  if (flat.length === 0) return <div className="flex flex-1 items-center justify-center p-8">{empty}</div>;

  // Each section's first row number, so rows count across sections.
  const offsets = visible.map((_, i) => visible.slice(0, i).reduce((n, s) => n + s.tasks.length, 0));
  return (
    <>
      <div ref={listRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {visible.map((section, sectionIndex) => (
          <section key={section.title ?? "all"} className="pt-5">
            {section.title && <h2 className="px-5 pb-2 text-sm text-muted">{section.title}</h2>}
            <ul>
              {section.tasks.map((task, n) => {
                const i = offsets[sectionIndex] + n;
                const isSelected = i === index;
                return (
                  <li key={task.id} data-row={i}>
                    <Link
                      href={`/tasks/${task.number}`}
                      onMouseMove={() => cursor !== i && setCursor(i)}
                      className={`block border-b border-line-soft px-5 py-4 ${isSelected ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <div className="flex items-baseline justify-between gap-6">
                        <p className={`flex min-w-0 items-center gap-2 text-[17px] ${task.priority === "urgent" ? "urgent-title" : ""}`}>
                          <span className="truncate">{task.title}</span>
                          {task.repeats && <Repeat size={13} className="shrink-0 text-faint" aria-label="Repeats" />}
                        </p>
                        <span className="label flex shrink-0 items-center gap-3">
                          {task.running && (
                            <span className="flex items-center gap-1.5 text-accent">
                              <LoaderCircle size={12} className="spin-slow" /> Working
                            </span>
                          )}
                          {showStatus && !task.running && <span>{task.laterUntil ? "Later" : STATUS_WORDS[task.status]}</span>}
                          <span className="hidden max-w-48 truncate sm:inline">{byline(task)}</span>
                          <When date={task.updatedAt} />
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[15px] text-muted">{task.summary || "No summary yet."}</p>
                      {isSelected && task.options.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
                          {task.options.map((option, n) => (
                            <button
                              key={option.label}
                              onClick={(e) => {
                                e.preventDefault();
                                pick(task, n);
                              }}
                              className="flex items-center gap-2 text-sm hover:text-ink"
                            >
                              <kbd className="kbd">{n + 1}</kbd>
                              <span className={option.recommended ? "text-ink" : "text-muted"}>{option.label}</span>
                              {option.recommended && <span className="label text-accent">Recommended</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <KeyHints
        hints={[
          [["J", "K"], "Move"],
          [["↵"], "Open"],
          [["E"], "Done"],
          [["1", "2", "3"], "Pick"],
          [["R"], "Reply"],
          [["L"], "Later"],
          [["⌘K"], "More"],
        ]}
      />
    </>
  );
}
