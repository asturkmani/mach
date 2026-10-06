"use client";

import { useActionState, useRef, useState, useTransition } from "react";

import type { PersonStatus } from "@/lib/people";

import { addPersonAction, inviteAction, removePersonAction, setManagerAction, type ActionResult } from "./actions";

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900";

function Feedback({ result }: { result: ActionResult }) {
  if (result.error) return <p className="text-xs text-red-600 dark:text-red-400">{result.error}</p>;
  if (result.message) return <p className="text-xs text-emerald-700 dark:text-emerald-400">{result.message}</p>;
  return null;
}

export function AddPersonForm({ managers }: { managers: string[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (previous, form) => {
    const result = await addPersonAction(previous, form);
    if (!result.error) formRef.current?.reset();
    return result;
  }, {});

  return (
    <form
      ref={formRef}
      action={action}
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="text-sm font-medium">Add someone</h2>
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
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
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
        className="max-w-44 rounded-md border border-transparent bg-transparent py-0.5 text-sm hover:border-zinc-300 dark:hover:border-zinc-700"
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
}: {
  personId: string;
  status: PersonStatus;
  hasEmail: boolean;
  inviteUrl: string | null;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const [copied, setCopied] = useState(false);
  const run = (action: () => Promise<ActionResult>) => startTransition(async () => setResult(await action()));
  const button =
    "rounded-md px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800";

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
        {canManage && (
          <button
            className={`${button} text-red-600 dark:text-red-400`}
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
