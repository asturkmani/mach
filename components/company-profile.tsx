"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";

import { PageBody } from "@/components/kit";
import { useShell } from "@/components/shell/shell";
import type { ChecklistItem } from "@/lib/profile/markdown";

export function CompanyProfile({
  profile,
  checklist,
  onboarded,
}: {
  profile: string;
  checklist: ChecklistItem[];
  onboarded: boolean;
}) {
  const { setCosOpen } = useShell();
  const [view, setView] = useState<"preview" | "markdown">("preview");

  return (
    <PageBody width="3xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-lg text-sm text-muted">
            What every agent reads before it works. The Chief of Staff keeps it current and suggests changes as it learns;
            you apply them from your inbox.
          </p>
          <div className="flex items-center gap-1">
            {(["preview", "markdown"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`btn ${view === v ? "" : "btn-ghost"} capitalize`}>
                {v}
              </button>
            ))}
            <a
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(profile)}`}
              download="company-profile.md"
              className="btn btn-ghost"
            >
              Download
            </a>
          </div>
        </div>

        {!onboarded && (
          <div className="mb-6 border border-line bg-raised p-4">
            <p className="label mb-3">Onboarding: the essentials</p>
            <ul className="space-y-1.5 text-sm">
              {checklist.map((item) => (
                <li key={item.label} className="flex items-baseline gap-2">
                  <span className={item.done ? "text-ok" : "text-faint"}>{item.done ? "✓" : "○"}</span>
                  <span className={item.done ? "" : "text-muted"}>{item.label}</span>
                  {item.detail && <span className="text-faint">· {item.detail}</span>}
                </li>
              ))}
            </ul>
            <button onClick={() => setCosOpen(true)} className="btn mt-4">
              Continue with the Chief of Staff <kbd className="kbd">C</kbd>
            </button>
          </div>
        )}

        {view === "preview" ? (
          <article className="prose prose-mach max-w-none prose-headings:font-normal prose-h1:text-3xl prose-h2:mt-10 prose-h2:font-mono prose-h2:text-[11px] prose-h2:uppercase prose-h2:tracking-widest prose-h2:text-muted prose-table:text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{profile}</ReactMarkdown>
          </article>
        ) : (
          <pre className="whitespace-pre-wrap border border-line bg-raised p-4 font-mono text-xs leading-relaxed">{profile}</pre>
        )}
    </PageBody>
  );
}
