"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { deleteIntegrationAction, testIntegrationAction, updateIntegrationAction } from "@/app/(app)/integrations/actions";
import { CredentialsForm, StatusLine } from "@/components/credentials-form";
import { useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";
import type { CredentialField, IntegrationKind, IntegrationStatus } from "@/lib/integrations";

// The Integrations page: each connected system with its status, who may use
// it, its access, credentials, the guide agents keep, and recent activity.

export type IntegrationView = {
  id: string;
  kind: IntegrationKind;
  slug: string;
  name: string;
  description: string;
  /** The base URL (data source) or sign-in page (login). */
  url: string;
  domains: string[];
  /** How requests are signed, without values: header and query names, and the token step's host. */
  signing: string;
  fields: CredentialField[];
  access: "read" | "write";
  agentIds: string[] | null;
  guide: string;
  status: IntegrationStatus;
  statusDetail: string;
  hasCredentials: boolean;
  lastUsedAt: string | null;
  calls: { method: string; path: string; status: number | null; by: string; taskNumber: number | null; at: string }[];
};

export function Integrations({ integrations, agents }: { integrations: IntegrationView[]; agents: { id: string; name: string }[] }) {
  if (integrations.length === 0) {
    return (
      <div className="max-w-xl space-y-2 border border-dashed border-line px-5 py-6">
        <p className="text-[15px]">Nothing connected yet.</p>
        <p className="text-sm text-muted">
          Ask the Chief of Staff (<kbd className="kbd">C</kbd>) to connect a system, e.g. &ldquo;Connect Masttro as a data source, the API
          docs are at …&rdquo;. It sets it up from the docs and shows you a secure card for the API key.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {integrations.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} agents={agents} />
      ))}
    </div>
  );
}

function IntegrationCard({ integration: i, agents }: { integration: IntegrationView; agents: { id: string; name: string }[] }) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const [credentials, setCredentials] = useState(!i.hasCredentials);
  const [choosing, setChoosing] = useState(false);
  const act = (work: () => Promise<{ error?: string; status?: IntegrationStatus; detail?: string }>, done?: string) =>
    start(async () => {
      const result = await work();
      if (result.error) return toast(result.error);
      if (result.status) toast(`${i.name}: ${result.status === "connected" ? "connected" : (result.detail ?? result.status)}`);
      else if (done) toast(done);
    });
  const who = i.agentIds ? agents.filter((a) => i.agentIds!.includes(a.id)).map((a) => a.name) : null;
  const toggleAgent = (id: string) => {
    const current = new Set(i.agentIds ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    act(() => updateIntegrationAction(i.id, { agentIds: current.size ? [...current] : null }));
  };

  return (
    <section className="border border-line bg-raised">
      <header className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
        <div className="min-w-0">
          <p className="label mb-1">
            {i.kind === "api" ? "Data source" : "Login"} · <span className="font-mono normal-case">{i.slug}</span>
          </p>
          <h2 className="text-[17px]">{i.name}</h2>
          {i.description && <p className="mt-1 text-sm text-muted">{i.description}</p>}
          <div className="mt-2">
            <StatusLine status={i.status} detail={i.statusDetail} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {i.kind === "api" && i.hasCredentials && (
            <button disabled={pending} onClick={() => act(() => testIntegrationAction(i.id))} className="btn btn-ghost">
              Test
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => act(() => updateIntegrationAction(i.id, { disabled: i.status !== "disabled" }), i.status === "disabled" ? "Turned on" : "Turned off")}
            className="btn btn-ghost"
          >
            {i.status === "disabled" ? "Turn on" : "Turn off"}
          </button>
          <button
            disabled={pending}
            onClick={() => confirm(`Remove ${i.name}? Its credentials are deleted and agents lose access.`) && act(() => deleteIntegrationAction(i.id), "Removed")}
            className="btn btn-ghost hover:text-danger"
          >
            Remove
          </button>
        </div>
      </header>

      <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="label pt-0.5">{i.kind === "api" ? "Base URL" : "Sign-in page"}</dt>
        <dd className="min-w-0 truncate font-mono text-xs leading-5">{i.url}</dd>
        {i.signing && (
          <>
            <dt className="label pt-0.5">Signed with</dt>
            <dd className="text-muted">{i.signing}</dd>
          </>
        )}
        <dt className="label pt-0.5">Access</dt>
        <dd>
          <select
            value={i.access}
            disabled={pending}
            onChange={(e) => act(() => updateIntegrationAction(i.id, { access: e.target.value as "read" | "write" }))}
            className="bg-transparent text-sm outline-none"
          >
            <option value="read">Read-only (GET)</option>
            <option value="write">Read and write</option>
          </select>
        </dd>
        <dt className="label pt-0.5">Who can use it</dt>
        <dd>
          <button onClick={() => setChoosing(!choosing)} className="flex items-center gap-1 text-left hover:text-ink">
            <span>{who ? (who.length ? who.join(", ") : "No agents") : "Every agent"}</span>
            <ChevronRight size={13} className={`text-faint transition-transform ${choosing ? "rotate-90" : ""}`} />
          </button>
          {choosing && (
            <div className="mt-2 space-y-1.5">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!i.agentIds}
                  onChange={() => act(() => updateIntegrationAction(i.id, { agentIds: i.agentIds ? null : [] }))}
                />
                Every agent
              </label>
              {i.agentIds &&
                agents.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 pl-5 text-sm">
                    <input type="checkbox" checked={i.agentIds!.includes(a.id)} onChange={() => toggleAgent(a.id)} />
                    {a.name}
                  </label>
                ))}
            </div>
          )}
        </dd>
        <dt className="label pt-0.5">Credentials</dt>
        <dd>
          {credentials ? (
            <div className="max-w-sm">
              <CredentialsForm id={i.id} fields={i.fields} hasCredentials={i.hasCredentials} onDone={() => setCredentials(false)} />
            </div>
          ) : (
            <button onClick={() => setCredentials(true)} className="text-muted hover:text-ink">
              Saved · update
            </button>
          )}
        </dd>
      </dl>

      {i.guide && (
        <details className="border-t border-line-soft px-5 py-3">
          <summary className="label cursor-pointer">Guide agents keep</summary>
          <div className="prose prose-mach prose-sm mt-3 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{i.guide}</ReactMarkdown>
          </div>
        </details>
      )}

      {i.calls.length > 0 && (
        <details className="border-t border-line-soft px-5 py-3">
          <summary className="label cursor-pointer">
            Recent activity{i.lastUsedAt ? <> · last <When date={i.lastUsedAt} /></> : null}
          </summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {i.calls.map((c, n) => (
              <li key={n} className="flex items-center gap-3">
                <span className="w-12 text-faint">{c.method}</span>
                <span className="min-w-0 flex-1 truncate">{c.path}</span>
                <span className={c.status && c.status < 400 ? "text-ok" : "text-danger"}>{c.status ?? "—"}</span>
                <span className="w-40 truncate text-right text-faint">
                  {c.taskNumber ? (
                    <Link href={`/tasks/${c.taskNumber}`} className="hover:text-ink">
                      #{c.taskNumber}
                    </Link>
                  ) : null}{" "}
                  {c.by}
                </span>
                <span className="w-20 text-right text-faint">
                  <When date={c.at} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
