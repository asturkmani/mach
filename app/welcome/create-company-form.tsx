"use client";

import { useActionState } from "react";

import { createCompany, type CreateCompanyState } from "./actions";

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900";

export function CreateCompanyForm({ defaultWebsite }: { defaultWebsite: string }) {
  const [state, action, pending] = useActionState<CreateCompanyState, FormData>(createCompany, {});

  return (
    <form action={action} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">Company name</span>
        <input name="name" required autoFocus className={inputClass} placeholder="Cedar Legacy" />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">
          Website <span className="font-normal text-zinc-500">(optional)</span>
        </span>
        <input name="website" defaultValue={defaultWebsite} className={inputClass} placeholder="cedarlegacy.com" />
      </label>
      {state.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}
