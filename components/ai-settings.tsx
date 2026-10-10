"use client";

import { useState, useTransition } from "react";

import { removeAiKeyAction, saveAiKeyAction, saveCompanyModelsAction } from "@/app/(app)/settings/ai/actions";
import { SettingRow } from "@/components/setting-row";

// Settings → AI: a row per provider to add, replace or remove the company's
// key (typed into a password field and sent straight to the server, never
// shown again), and the company's default models.

type Provider = { slug: string; name: string; placeholder: string; keysUrl: string };

export function AiKeyRow({ provider, saved, canEdit }: { provider: Provider; saved: { hint: string; addedAt: string } | null; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await saveAiKeyAction(provider.slug, key);
      if (result.error) setError(result.error);
      else {
        setKey("");
        setError(null);
        setTested(result.testedOn ?? null);
        setOpen(false);
      }
    });

  return (
    <SettingRow
      title={provider.name}
      description={
        saved ? (
          <span>
            Your key ending <span className="font-mono">{saved.hint}</span>, added {new Date(saved.addedAt).toLocaleDateString()}
            {tested && (
              <span className="block text-ok">
                Working: a test call on <span className="font-mono">{tested}</span> ran on your key.
              </span>
            )}
          </span>
        ) : (
          "Using Mach1's account"
        )
      }
      action={
        canEdit && !open ? (
          <>
            <button className="btn" onClick={() => setOpen(true)}>
              {saved ? "Replace" : "Add key"}
            </button>
            {saved && (
              <button
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => {
                  if (confirm(`Remove your ${provider.name} key? Work goes back to Mach1's account.`)) start(async () => void (await removeAiKeyAction(provider.slug)));
                }}
              >
                Remove
              </button>
            )}
          </>
        ) : null
      }
    >
      {open && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.placeholder}
            className="field font-mono text-[13px]"
            aria-label={`${provider.name} API key`}
            autoFocus
          />
          <p className="text-xs text-faint">
            Create one in your{" "}
            <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="underline">
              {provider.name} console
            </a>
            . Before it&apos;s saved, it&apos;s checked with {provider.name} and with one tiny test call on your account.
          </p>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={pending || !key.trim()}>
              {pending ? "Testing…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setOpen(false);
                setKey("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </SettingRow>
  );
}

type Models = { chiefOfStaff?: string; agents?: string };

export function CompanyModelsForm({
  models,
  fallback,
  choices,
  canEdit,
}: {
  models: Models;
  fallback: { chiefOfStaff: string; agents: string };
  choices: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<Models>(models);
  const [state, setState] = useState<{ error?: string; saved?: boolean }>({});
  const [pending, start] = useTransition();
  const field = (key: keyof Models, label: string, hint: string) => (
    <label className="block space-y-1.5">
      <span className="label">{label}</span>
      <input
        list="company-models"
        value={draft[key] ?? ""}
        onChange={(e) => {
          setDraft({ ...draft, [key]: e.target.value });
          setState({});
        }}
        disabled={!canEdit}
        placeholder={fallback[key] ? `Mach1's default: ${fallback[key]}` : "provider/model"}
        className="field font-mono text-[13px]"
      />
      <span className="block text-xs text-faint">{hint}</span>
    </label>
  );
  return (
    <div className="space-y-4">
      {field("chiefOfStaff", "Chief of Staff", "Answers, routes and delegates: a fast model with good tool use is enough.")}
      {field("agents", "Agents", "The default for agents doing the work. Each agent can override it on its page.")}
      <datalist id="company-models">
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await saveCompanyModelsAction(draft);
                setState(result.error ? { error: result.error } : { saved: true });
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
          {state.saved && <p className="text-sm text-ok">Saved.</p>}
        </div>
      )}
    </div>
  );
}
