"use client";

import { useState, useTransition } from "react";

import { savePersonalNotesAction } from "@/app/(app)/settings/actions";

// What your assistant knows about you, in Settings → Account: it writes these
// notes as it learns, and you can read and correct them.

export function PersonalNotes({ notes }: { notes: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <div className="space-y-3">
        {notes ? (
          <p className="text-sm whitespace-pre-wrap text-ink">{notes}</p>
        ) : (
          <p className="text-sm text-faint">Nothing yet. It notes things as you talk: how you like answers, what you look after, what it&apos;s following up on.</p>
        )}
        <button
          className="btn"
          onClick={() => {
            setDraft(notes);
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className="field font-mono text-[13px]" />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await savePersonalNotesAction(draft);
              if (result.error) setError(result.error);
              else setEditing(false);
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
