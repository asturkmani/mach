"use client";

import { useActionState, useRef, useState, useTransition } from "react";

import { useShell } from "@/components/shell/shell";
import { useCloseForm } from "@/components/kit";
import type { PersonStatus } from "@/lib/people";

import { addPersonAction, inviteAction, removePersonAction, setManagerAction, setRoleAction, updatePersonAction, type ActionResult } from "./actions";

const inputClass = "field";

function Feedback({ result }: { result: ActionResult }) {
  if (result.error) return <p className="text-xs text-danger">{result.error}</p>;
  if (result.message) return <p className="text-xs text-ok">{result.message}</p>;
  return null;
}

export function AddPersonForm({ managers, canInvite }: { managers: string[]; canInvite: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const close = useCloseForm();
  const { toast } = useShell();
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (previous, form) => {
    const result = await addPersonAction(previous, form);
    if (!result.error) {
      // Added: the form goes away, and what happened shows briefly.
      if (result.message) toast(result.message);
      close();
    }
    return result;
  }, {});

  return (
    <form
      ref={formRef}
      action={action}
      className="space-y-3 border border-line bg-raised p-4"
    >
      <h2 className="label">Add someone</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="name" required placeholder="Name" className={inputClass} />
        <input name="role" placeholder="Role, e.g. Finance lead" className={inputClass} />
        <select name="manager" defaultValue="" className={inputClass}>
          <option value="">Reports to no one</option>
          {managers.map((name) => (
            <option key={name} value={name}>
              Reports to {name}
            </option>
          ))}
        </select>
        <input name="email" type="email" placeholder="Email (needed to invite)" className={inputClass} />
        <input name="phone" placeholder="Phone / WhatsApp (optional)" className={inputClass} />
      </div>
      {canInvite && (
        <label className="flex w-fit items-center gap-2 text-sm">
          <input name="invite" type="checkbox" defaultChecked />
          Invite them to Mach1 by email
        </label>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary"
        >
          {pending ? "Adding…" : "Add"}
        </button>
        <Feedback result={state} />
      </div>
    </form>
  );
}

export function ManagerSelect({ personId, value, options }: { personId: string; value: string; options: string[] }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  return (
    <div>
      <select
        defaultValue={value}
        disabled={pending}
        onChange={(e) => {
          const managerName = e.target.value;
          startTransition(async () => setResult(await setManagerAction(personId, managerName)));
        }}
        className="max-w-44 border border-transparent bg-transparent py-0.5 text-sm hover:border-line"
      >
        <option value="">No one</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Feedback result={result} />
    </div>
  );
}

export function PersonActions({
  personId,
  status,
  hasEmail,
  inviteUrl,
  canManage,
  role,
}: {
  personId: string;
  status: PersonStatus;
  hasEmail: boolean;
  inviteUrl: string | null;
  canManage: boolean;
  /** Their role in the company, once they've joined. */
  role: "admin" | "member" | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const [copied, setCopied] = useState(false);
  const run = (action: () => Promise<ActionResult>) => startTransition(async () => setResult(await action()));
  const button = "px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-50";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        {canManage && status !== "active" && (
          <button
            className={button}
            disabled={pending || !hasEmail}
            title={hasEmail ? undefined : "Add an email address to invite"}
            onClick={() => run(() => inviteAction(personId))}
          >
            {status === "invited" ? "Resend invite" : "Invite"}
          </button>
        )}
        {status === "invited" && inviteUrl && (
          <button
            className={button}
            onClick={async () => {
              await navigator.clipboard.writeText(inviteUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy invite link"}
          </button>
        )}
        {canManage && role && (
          <button
            className={button}
            disabled={pending}
            onClick={() => run(() => setRoleAction(personId, role === "admin" ? "member" : "admin"))}
          >
            {role === "admin" ? "Make member" : "Make admin"}
          </button>
        )}
        {canManage && (
          <button
            className={`${button} hover:text-danger`}
            disabled={pending}
            onClick={() => {
              if (confirm("Remove this person from the team?")) run(() => removePersonAction(personId));
            }}
          >
            Remove
          </button>
        )}
      </div>
      <Feedback result={result} />
    </div>
  );
}

/**
 * A detail on the Team page that turns into a field when clicked: Enter (or
 * clicking away) saves, Esc puts it back. Locked ones say why instead.
 */
export function EditableText({
  personId,
  field,
  value,
  placeholder,
  label,
  locked,
  className = "",
  multiline = false,
}: {
  personId: string;
  field: "name" | "role" | "responsibilities" | "email" | "phone";
  value: string;
  placeholder: string;
  label: string;
  /** Why it can't be edited here, if it can't. */
  locked?: string;
  className?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const cancelled = useRef(false);

  if (locked) {
    return (
      <span className={className} title={locked}>
        {value || <span className="text-faint">{placeholder}</span>}
      </span>
    );
  }
  const save = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    if (draft.trim() === value.trim()) return;
    startTransition(async () => {
      const outcome = await updatePersonAction(personId, { [field]: draft });
      setResult(outcome);
      if (outcome.error) setDraft(value);
    });
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      cancelled.current = true;
      setDraft(value);
      setEditing(false);
    } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  const input = "field w-full px-1.5 py-0.5";

  return (
    <span className="block">
      {editing ? (
        multiline ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={keys}
            rows={2}
            aria-label={label}
            placeholder={placeholder}
            className={`${input} resize-y text-sm`}
          />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={keys}
            aria-label={label}
            placeholder={placeholder}
            className={`${input} ${className}`}
          />
        )
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setResult({});
            setEditing(true);
          }}
          disabled={pending}
          title={`Edit ${label.toLowerCase()}`}
          className={`-mx-1 cursor-text rounded-none px-1 text-left hover:bg-hover disabled:opacity-60 ${className}`}
        >
          {(pending ? draft : value) || <span className="text-faint">{placeholder}</span>}
        </button>
      )}
      {result.error && <span className="block text-xs text-danger">{result.error}</span>}
    </span>
  );
}
