"use client";

import { useActionState } from "react";

import { createCompany, type CreateCompanyState } from "./actions";

const inputClass = "field";

export function CreateCompanyForm({ defaultWebsite }: { defaultWebsite: string }) {
  const [state, action, pending] = useActionState<CreateCompanyState, FormData>(createCompany, {});

  return (
    <form action={action} className="space-y-4">
      <label className="block space-y-1">
        <span className="label">Company name</span>
        <input name="name" required autoFocus className={inputClass} placeholder="Cedar Legacy" />
      </label>
      <label className="block space-y-1">
        <span className="label">
          Website <span className="text-faint">(optional)</span>
        </span>
        <input name="website" defaultValue={defaultWebsite} className={inputClass} placeholder="cedarlegacy.com" />
      </label>
      {state.error && (
        <p className="border border-danger/40 px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary w-full justify-center py-2"
      >
        {pending ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}
