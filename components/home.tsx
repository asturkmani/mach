"use client";

import { List, SquareKanban } from "lucide-react";
import { useRouter } from "next/navigation";

import { Board } from "@/components/board";
import { PageHeader } from "@/components/page-header";
import { useKeys, useShell } from "@/components/shell/shell";
import { TaskList, type Section } from "@/components/task-list";
import type { TaskView } from "@/lib/task-view";

// Home: what needs you at the top, then all the work, as a board (the
// default) or a to-do list. V switches between them.

export type HomeView = "board" | "list";
export type HomeScope = "everyone" | "mine";

const remember = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
};

/** The to-do list: work grouped by where it stands, after what needs you. */
function listSections(needsYou: TaskView[], work: TaskView[]): Section[] {
  const now = Date.now();
  const yours = new Set(needsYou.map((t) => t.id));
  const rest = work.filter((t) => !yours.has(t.id));
  const later = (t: TaskView) => Boolean(t.laterUntil && new Date(t.laterUntil).getTime() > now);
  const groups: Record<string, TaskView[]> = { progress: [], others: [], later: [], backlog: [], done: [] };
  for (const t of rest) {
    if (t.status === "done") groups.done.push(t);
    else if (t.status === "backlog") groups.backlog.push(t);
    else if (later(t)) groups.later.push(t);
    else if (t.running || t.status === "in_progress" || t.status === "ready") groups.progress.push(t);
    else groups.others.push(t);
  }
  return [
    { title: "Needs you", tasks: needsYou },
    { title: "In progress", tasks: groups.progress },
    { title: "Waiting on someone else", tasks: groups.others },
    { title: "Later", tasks: groups.later },
    { title: "Backlog", tasks: groups.backlog },
    { title: "Done recently", tasks: groups.done.slice(0, 15) },
  ];
}

export function Home({
  view,
  scope,
  needsYou,
  work,
  notice,
}: {
  view: HomeView;
  scope: HomeScope;
  needsYou: TaskView[];
  work: TaskView[];
  notice?: React.ReactNode;
}) {
  const router = useRouter();
  const { data } = useShell();
  const mine = (t: TaskView) => t.people.some((p) => p.id === data.me.personId);
  const shown = scope === "mine" ? work.filter(mine) : work;

  const setView = (next: HomeView) => {
    remember("mach-home-view", next);
    router.replace("/");
    router.refresh();
  };
  const setScope = (next: HomeScope) => {
    remember("mach-home-scope", next);
    router.refresh();
  };
  useKeys({ v: () => setView(view === "board" ? "list" : "board") });

  const toggle = (options: { value: string; label: React.ReactNode; title: string }[], current: string, onPick: (v: string) => void) => (
    <div className="flex border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          title={o.title}
          aria-pressed={current === o.value}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs ${current === o.value ? "bg-selected text-ink" : "text-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  const empty = (
    <div className="max-w-sm space-y-2 text-center">
      <p className="text-[17px]">{needsYou.length || shown.length ? "Nothing else here." : "Nothing yet."}</p>
      <p className="text-sm text-muted">
        Work comes back to the top of Home when an agent finishes or needs a decision. Press <kbd className="kbd">N</kbd> for a
        new task, or <kbd className="kbd">C</kbd> to ask the Chief of Staff.
      </p>
    </div>
  );

  return (
    <>
      <PageHeader title="Home" count={needsYou.length || undefined}>
        <div className="mr-2 flex items-center gap-2">
          {toggle(
            [
              { value: "everyone", label: "Everyone", title: "All the company's work" },
              { value: "mine", label: "Mine", title: "Work you're on" },
            ],
            scope,
            (v) => setScope(v as HomeScope),
          )}
          {toggle(
            [
              { value: "board", label: <><SquareKanban size={13} /> Board</>, title: "Board (V)" },
              { value: "list", label: <><List size={13} /> List</>, title: "List (V)" },
            ],
            view,
            (v) => setView(v as HomeView),
          )}
        </div>
      </PageHeader>
      {notice}
      {view === "list" ? (
        <TaskList sections={listSections(needsYou, shown)} showStatus empty={empty} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {needsYou.length > 0 && (
            <div className="flex max-h-[42%] min-h-0 shrink-0 flex-col border-b border-line">
              <TaskList sections={[{ title: `Needs you · ${needsYou.length}`, tasks: needsYou }]} empty={null} hints={false} />
            </div>
          )}
          {/* The board's own keys work when nothing needs you; otherwise J/K move through what does. */}
          <Board tasks={shown} keyboard={needsYou.length === 0} />
        </div>
      )}
    </>
  );
}
