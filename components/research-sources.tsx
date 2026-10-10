"use client";

import { AtSign, Globe, MessagesSquare, Sparkles, UserRound, X } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";

import { addSourceAction, removeSourceAction, updateSourceAction, type SourceActionResult } from "@/app/(app)/research/actions";
import { DataCell, DataRow, DataTable, useCloseForm, VisibilityToggle } from "@/components/kit";
import { startCosMessage, useShell } from "@/components/shell/shell";
import { KIND_WORDS, type SourceKind } from "@/lib/research/sources";

// The Research screen: the sources people trust most, which the Researcher
// looks at first. Adding, sharing and removing go through the same actions
// the Chief of Staff uses in chat.

export type SourceRow = {
  id: string;
  kind: SourceKind;
  label: string;
  url: string;
  note: string;
  visibility: "company" | "private";
  mine: boolean;
  canChange: boolean;
};

const ICONS: Record<SourceKind, typeof Globe> = { website: Globe, x_account: AtSign, subreddit: MessagesSquare, reddit_user: UserRound };

/** Opens the Chief of Staff with a research request started. */
export function AskResearcher() {
  const { setCosOpen } = useShell();
  return (
    <button onClick={() => startCosMessage("Research ", setCosOpen)} className="btn" title="Ask for research in the chat">
      <Sparkles size={14} /> New research
    </button>
  );
}

export function AddSourceForm() {
  const close = useCloseForm();
  const { toast } = useShell();
  const [state, action, pending] = useActionState<SourceActionResult, FormData>(async (previous, form) => {
    const result = await addSourceAction(previous, form);
    if (!result.error) {
      if (result.message) toast(result.message);
      close();
    }
    return result;
  }, {});
  return (
    <form action={action} className="space-y-3 border border-line bg-raised p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <input name="source" required placeholder="ft.com, @DeItaone, r/investing, u/someone or a link" className="field" autoFocus />
        <select name="kind" defaultValue="" className="field" aria-label="Kind">
          <option value="">Work out the kind</option>
          {(Object.keys(KIND_WORDS) as SourceKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_WORDS[kind].one[0].toUpperCase() + KIND_WORDS[kind].one.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <input name="note" maxLength={300} placeholder="Why it's worth reading, e.g. breaking macro headlines" className="field" />
      <label className="flex w-fit items-center gap-2 text-sm">
        <input name="share" type="checkbox" />
        Use it for everyone&apos;s research (the company&apos;s)
      </label>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save source"}
        </button>
        {state.error && <p className="text-xs text-danger">{state.error}</p>}
      </div>
    </form>
  );
}

export function SourceTable({ sources }: { sources: SourceRow[] }) {
  return (
    <DataTable columns={["Source", "Why it's worth reading", "Who", ""]}>
      {sources.map((source) => {
        const Icon = ICONS[source.kind];
        return (
          <DataRow key={source.id}>
            <DataCell main>
              <div className="flex items-center gap-2">
                <Icon size={14} className="shrink-0 text-faint" />
                <div className="min-w-0">
                  <a href={source.url} target="_blank" rel="noreferrer" className="break-all hover:underline">
                    {source.label}
                  </a>
                  <p className="text-xs text-faint">{KIND_WORDS[source.kind].one}</p>
                </div>
              </div>
            </DataCell>
            <DataCell label="Why" className="md:max-w-80">
              <Note id={source.id} value={source.note} canChange={source.canChange} />
            </DataCell>
            <DataCell label="Who">
              <VisibilityToggle
                visibility={source.visibility}
                canChange={source.canChange}
                privateMeans="Only your research"
                change={(next) => updateSourceAction(source.id, { shareWithCompany: next === "company" })}
              />
            </DataCell>
            <DataCell end>{source.canChange && <Remove id={source.id} label={source.label} />}</DataCell>
          </DataRow>
        );
      })}
    </DataTable>
  );
}

function Note({ id, value, canChange }: { id: string; value: string; canChange: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cancelled = useRef(false);

  if (!canChange) return <span className="text-sm text-muted">{value || "—"}</span>;
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="text-left text-sm text-muted hover:text-ink" title="Edit why it's worth reading">
        {value || <span className="text-faint">Add why</span>}
        {error && <span className="block text-xs text-danger">{error}</span>}
      </button>
    );
  }
  const save = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    if (draft.trim() === value.trim()) return;
    start(async () => {
      const result = await updateSourceAction(id, { note: draft });
      setError(result.error ?? null);
      if (result.error) setDraft(value);
    });
  };
  return (
    <input
      autoFocus
      value={draft}
      maxLength={300}
      disabled={pending}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(value);
          setEditing(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="field w-full px-1.5 py-0.5 text-sm"
    />
  );
}

function Remove({ id, label }: { id: string; label: string }) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  return (
    <button
      className="btn btn-ghost"
      disabled={pending}
      title={`Stop treating ${label} as high signal`}
      onClick={() =>
        start(async () => {
          const result = await removeSourceAction(id);
          toast(result.error ?? result.message ?? "Removed");
        })
      }
    >
      <X size={14} /> Remove
    </button>
  );
}
