"use client";

import { useState, useTransition } from "react";

import { deleteCompanyAction } from "@/app/(app)/company/actions";
import { SettingRow } from "@/components/setting-row";

/** The admin's way to delete the company and everything it has in Mach. */
export function DeleteCompany({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  return (
    <SettingRow
      title="Delete company"
      description={<>Removes {name} and everything in it from Mach. This can&apos;t be undone.</>}
      action={
        !open && (
          <button onClick={() => setOpen(true)} className="btn hover:border-danger hover:text-danger">
            Delete…
          </button>
        )
      }
    >
      {open && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!matches) return;
            setError(undefined);
            start(async () => {
              const result = await deleteCompanyAction(typed);
              if (result?.error) setError(result.error);
            });
          }}
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Every task and its thread, every agent, and the Chief of Staff&apos;s chats</li>
            <li>The file library, the company drive and attachments</li>
            <li>Integrations and their saved credentials and sessions</li>
            <li>Every job&apos;s sandbox, and the Chief of Staff&apos;s</li>
            <li>The team list and pending invitations. People keep their own sign-in, for any other company they&apos;re in.</li>
          </ul>
          <label className="block">
            <span className="label mb-1 block">Type {name} to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="field w-full max-w-sm" />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={!matches || pending} className="btn border-danger bg-danger text-white disabled:opacity-50">
              {pending ? "Deleting…" : "Delete everything"}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={pending} className="btn btn-ghost">
              Cancel
            </button>
          </div>
        </form>
      )}
    </SettingRow>
  );
}
