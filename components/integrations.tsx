"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  deleteIntegrationAction,
  forgetSessionAction,
  testIntegrationAction,
  updateIntegrationAction,
} from "@/app/(app)/integrations/actions";
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
  /** The people whose work may use it; null is everyone. */
  personIds: string[] | null;
  guide: string;
  status: IntegrationStatus;
  statusDetail: string;
  hasCredentials: boolean;
  hasSession: boolean;
  lastUsedAt: string | null;
  calls: { method: string; path: string; status: number | null; by: string; taskNumber: number | null; at: string }[];
};

type Named = { id: string; name: string };

export function Integrations({
  integrations,
  people,
  canChoosePeople,
}: {
  integrations: IntegrationView[];
  people: Named[];
  /** Admins decide which people may use each integration. */
  canChoosePeople: boolean;
}) {
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
        <IntegrationCard key={integration.id} integration={integration} people={people} canChoosePeople={canChoosePeople} />
      ))}
    </div>
  );
}

function IntegrationCard({
  integration: i,
  people,
  canChoosePeople,
}: {
  integration: IntegrationView;
  people: Named[];
  canChoosePeople: boolean;
}) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const [credentials, setCredentials] = useState(!i.hasCredentials);
  const act = (work: () => Promise<{ error?: string; status?: IntegrationStatus; detail?: string }>, done?: string) =>
    start(async () => {
      const result = await work();
      if (result.error) return toast(result.error);
      if (result.status) toast(`${i.name}: ${result.status === "connected" ? "connected" : (result.detail ?? result.status)}`);
      else if (done) toast(done);
    });
  const [choosingPeople, setChoosingPeople] = useState(false);
  const whoPeople = i.personIds ? people.filter((p) => i.personIds!.includes(p.id)).map((p) => p.name) : null;
  const togglePerson = (id: string) => {
    const current = new Set(i.personIds ?? []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    act(() => updateIntegrationAction(i.id, { personIds: [...current] }));
  };

  return (
    <section className="border border-line bg-raised">
      <header className="flex flex-col items-start justify-between gap-2 border-b border-line-soft px-4 py-4 sm:flex-row sm:gap-4 sm:px-5">
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

      <dl className="grid gap-x-6 gap-y-1 px-4 py-4 text-sm sm:grid-cols-[9rem_1fr] sm:gap-y-3 sm:px-5">
        <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">{i.kind === "api" ? "Base URL" : "Sign-in page"}</dt>
        <dd className="min-w-0 truncate font-mono text-xs leading-5">{i.url}</dd>
        {i.signing && (
          <>
            <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">Signed with</dt>
            <dd className="text-muted">{i.signing}</dd>
          </>
        )}
        {i.kind === "login" && (
          <>
            <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">Session</dt>
            <dd className="flex items-center gap-3">
              <span className="text-muted">{i.hasSession ? "Signed in · saved for the next run" : "Not signed in yet"}</span>
              {i.hasSession && (
                <button
                  disabled={pending}
                  onClick={() => act(() => forgetSessionAction(i.id), "Session forgotten")}
                  className="text-xs text-faint hover:text-ink"
                >
                  Forget
                </button>
              )}
            </dd>
          </>
        )}
        {i.kind === "api" && (
          <>
            <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">Access</dt>
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
          </>
        )}
        <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">Whose work</dt>
        <dd>
          {canChoosePeople ? (
            <button onClick={() => setChoosingPeople(!choosingPeople)} className="flex items-center gap-1 text-left hover:text-ink">
              <span>{whoPeople ? (whoPeople.length ? whoPeople.join(", ") : "No one") : "Everyone's"}</span>
              <ChevronRight size={13} className={`text-faint transition-transform ${choosingPeople ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span>{whoPeople ? (whoPeople.length ? whoPeople.join(", ") : "No one") : "Everyone's"}</span>
          )}
          {choosingPeople && canChoosePeople && (
            <div className="mt-2 space-y-1.5">
              <p className="text-xs text-faint">Whose assistant, and the work it does for them, may use it.</p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!i.personIds}
                  onChange={() => act(() => updateIntegrationAction(i.id, { personIds: i.personIds ? null : [] }))}
                />
                Everyone
              </label>
              {i.personIds &&
                people.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 pl-5 text-sm">
                    <input type="checkbox" checked={i.personIds!.includes(p.id)} onChange={() => togglePerson(p.id)} />
                    {p.name}
                  </label>
                ))}
            </div>
          )}
        </dd>
        <dt className="label mt-2 pt-0.5 first:mt-0 sm:mt-0">Credentials</dt>
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
          <p className="mt-2 text-xs text-faint">Requests made with call_api. Code in job sandboxes calls the API directly and isn&apos;t listed.</p>
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
