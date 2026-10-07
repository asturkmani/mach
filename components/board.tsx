"use client";

import { LoaderCircle, Repeat } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { restoreAction, setStatusAction } from "@/app/(app)/tasks/actions";
import { useKeys, useShell } from "@/components/shell/shell";
import { Face, PriorityMark } from "@/components/ui";
import type { TaskView } from "@/lib/task-view";
import { BOARD_COLUMNS, STATUS_WORDS, type TaskStatus } from "@/lib/task-words";

// The company board: one column per status. Drag a card to move it, or use
// J/K to move through a column, H/L to move between columns and Enter to open.

export function Board({ tasks }: { tasks: TaskView[] }) {
  const router = useRouter();
  const { pushUndo, toast } = useShell();
  const [moved, setMoved] = useState<Record<string, TaskStatus>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [cursor, setCursor] = useState<{ column: number; row: number }>({ column: 0, row: 0 });
  const [, start] = useTransition();

  const statusOf = (task: TaskView) => moved[task.id] ?? task.status;
  const columns = BOARD_COLUMNS.map((status) => ({ status, tasks: tasks.filter((t) => statusOf(t) === status) }));

  const move = (task: TaskView, status: TaskStatus) => {
    if (statusOf(task) === status) return;
    setMoved((all) => ({ ...all, [task.id]: status }));
    start(async () => {
      const result = await setStatusAction(task.id, status);
      if (result.error) {
        setMoved((all) => ({ ...all, [task.id]: task.status }));
        return toast(result.error);
      }
      const previous = result.snapshot;
      if (previous) {
        pushUndo(`Moved #${task.number} to ${STATUS_WORDS[status]}`, async () => {
          setMoved((all) => ({ ...all, [task.id]: previous.status }));
          await restoreAction(task.id, previous);
        });
      }
    });
  };

  const column = Math.min(cursor.column, columns.length - 1);
  const row = Math.min(cursor.row, Math.max(0, columns[column].tasks.length - 1));
  const selected = columns[column].tasks[row];
  const go = (dc: number, dr: number) => {
    const c = Math.max(0, Math.min(columns.length - 1, column + dc));
    setCursor({ column: c, row: dc ? 0 : Math.max(0, row + dr) });
  };

  useKeys({
    j: () => go(0, 1),
    down: () => go(0, 1),
    k: () => go(0, -1),
    up: () => go(0, -1),
    h: () => go(-1, 0),
    arrowleft: () => go(-1, 0),
    arrowright: () => go(1, 0),
    enter: () => selected && router.push(`/tasks/${selected.number}`),
    "[": () => selected && column > 0 && move(selected, BOARD_COLUMNS[column - 1]),
    "]": () => selected && column < BOARD_COLUMNS.length - 1 && move(selected, BOARD_COLUMNS[column + 1]),
  });

  return (
    <div className="scroll-quiet flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {columns.map(({ status, tasks: cards }, c) => (
        <section
          key={status}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(status);
          }}
          onDragLeave={() => setOver((s) => (s === status ? null : s))}
          onDrop={(e) => {
            e.preventDefault();
            const task = tasks.find((t) => t.id === dragging);
            if (task) move(task, status);
            setDragging(null);
            setOver(null);
          }}
          className={`flex min-w-60 flex-1 flex-col border ${over === status ? "border-accent/60 bg-accent-soft" : "border-line-soft"}`}
        >
          <header className="flex items-center justify-between px-3 py-2.5">
            <h2 className="label">{STATUS_WORDS[status]}</h2>
            <span className="label text-faint">{cards.length}</span>
          </header>
          <ul className="scroll-quiet min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {cards.map((task, r) => (
              <li
                key={task.id}
                draggable
                onDragStart={() => setDragging(task.id)}
                onDragEnd={() => setDragging(null)}
                className={dragging === task.id ? "opacity-40" : ""}
              >
                <Link
                  href={`/tasks/${task.number}`}
                  onMouseMove={() => (cursor.column !== c || cursor.row !== r) && setCursor({ column: c, row: r })}
                  className={`block border bg-raised px-3 py-2.5 ${
                    c === column && r === row ? "border-muted" : "border-line hover:border-muted"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="label text-faint">#{task.number}</span>
                    <span className="flex items-center gap-2">
                      {task.running && <LoaderCircle size={12} className="spin-slow text-accent" />}
                      {task.laterUntil && <span className="label text-faint">Later</span>}
                      {task.repeats && <Repeat size={12} className="text-faint" aria-label="Repeats" />}
                      <PriorityMark priority={task.priority} />
                    </span>
                  </div>
                  <p className={`text-[15px] leading-snug ${task.priority === "urgent" ? "urgent-title" : ""}`}>{task.title}</p>
                  {task.summary && <p className="mt-1 line-clamp-2 text-sm text-muted">{task.summary}</p>}
                  <div className="mt-2.5 flex items-center gap-1">
                    {task.people.map((p) => (
                      <Face key={p.id} name={p.name} size={20} />
                    ))}
                    {task.agents.map((a) => (
                      <Face key={a.id} name={a.name} agent size={20} />
                    ))}
                  </div>
                </Link>
              </li>
            ))}
            {cards.length === 0 && <li className="px-1 py-6 text-center text-xs text-faint">Nothing here</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}
