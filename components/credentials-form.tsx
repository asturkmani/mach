"use client";

import { LockKeyhole } from "lucide-react";
import { useState, useTransition } from "react";

import { saveCredentialsAction } from "@/app/(app)/integrations/actions";
import type { CredentialField, IntegrationStatus } from "@/lib/integrations";

// Where people enter an integration's credentials. The values go straight to
// sealed storage through a server action, never through the Chief of Staff or
// the chat, and are never shown again.

export const STATUS_WORDS: Record<IntegrationStatus, string> = {
  needs_credentials: "Needs credentials",
  connected: "Connected",
  failing: "Failing",
  disabled: "Turned off",
};

export function StatusLine({ status, detail }: { status: IntegrationStatus; detail?: string }) {
  const color = status === "connected" ? "text-ok" : status === "failing" ? "text-danger" : "text-muted";
  return (
    <p className={`text-xs ${color}`}>
      <span className="mr-1.5">{status === "connected" ? "●" : status === "failing" ? "✕" : "○"}</span>
      {STATUS_WORDS[status]}
      {detail ? <span className="text-faint"> · {detail}</span> : null}
    </p>
  );
}

export function CredentialsForm({
  id,
  fields,
  hasCredentials,
  onDone,
}: {
  id: string;
  fields: CredentialField[];
  hasCredentials: boolean;
  onDone?: (result: { status?: IntegrationStatus; detail?: string }) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ status?: IntegrationStatus; detail?: string; error?: string }>();

  const save = () =>
    start(async () => {
      const outcome = await saveCredentialsAction(id, values);
      setResult(outcome);
      if (!outcome.error) {
        setValues({});
        onDone?.(outcome);
      }
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-2.5"
      autoComplete="off"
    >
      {fields.map((field) => (
        <label key={field.name} className="block">
          <span className="label mb-1 block">
            {field.label}
            {field.optional ? <span className="text-faint"> · optional</span> : null}
          </span>
          <input
            type={field.secret === false ? "text" : "password"}
            autoComplete={field.secret === false ? "off" : "new-password"}
            value={values[field.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            placeholder={hasCredentials ? "Saved · leave blank to keep" : ""}
            className="field py-1.5 font-mono text-sm"
          />
        </label>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Testing…" : hasCredentials ? "Update and test" : "Save and test"}
        </button>
        <span className="flex items-center gap-1.5 text-xs text-faint">
          <LockKeyhole size={12} /> Encrypted. Agents never see it.
        </span>
      </div>
      {result?.error && <p className="text-xs text-danger">{result.error}</p>}
      {result?.status && <StatusLine status={result.status} detail={result.detail} />}
    </form>
  );
}
