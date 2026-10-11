"use client";

import { ChevronRight } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import Link from "next/link";

import {
  archiveSkillAction,
  decideProposalAction,
  restoreSkillAction,
  saveSkillAction,
  shareSkillAction,
  type SkillActionResult,
} from "@/app/(app)/skills/actions";
import { useCloseForm, VisibilityToggle } from "@/components/kit";
import { useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";

// The Skills screen: the company's own skills (how it does its work, how its
// systems work) with every version, and Mach1's. Writing, sharing, restoring
// and retiring go through the same actions the Chief of Staff uses in chat.

export type CompanySkillView = {
  name: string;
  kind: "workflow" | "integration";
  description: string;
  body: string;
  extends: string | null;
  scripts: string[];
  owner: string | null;
  visibility: "company" | "private";
  version: number;
  updatedAt: string;
  canChange: boolean;
  versions: { version: number; note: string; author: string; taskNumber: number | null; at: string }[];
};

export type BaseSkillView = { name: string; description: string; body: string };

export type ProposalView = {
  from: number;
  number: number;
  why: string;
  /** What it changes: a skill (new or not) or a profile section. */
  what: string;
  /** The new text, for a look before saying yes. */
  text: string;
  sourceNumber: number | null;
};

/** Changes Mach1 proposed after reviewing finished work, waiting on this person's yes. */
export function Proposals({ proposals }: { proposals: ProposalView[] }) {
  const { toast } = useShell();
  const [pending, start] = useTransition();
  const decide = (p: ProposalView, apply: boolean) =>
    start(async () => {
      const result = await decideProposalAction(p.from, p.number, apply);
      toast(result.error ?? result.message ?? "Done");
    });
  return (
    <ul className="space-y-3">
      {proposals.map((p) => (
        <li key={`${p.from}-${p.number}`} className="border border-line bg-raised px-4 py-3">
          <p className="label mb-1">
            {p.what}
            {p.sourceNumber ? (
              <>
                {" "}
                · from{" "}
                <Link href={`/tasks/${p.sourceNumber}`} className="hover:text-ink">
                  #{p.sourceNumber}
                </Link>
              </>
            ) : null}
          </p>
          <p className="text-sm">{p.why}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-faint">See the new text</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted">{p.text}</pre>
          </details>
          <div className="mt-3 flex gap-2">
            <button disabled={pending} onClick={() => decide(p, true)} className="btn">
              Apply
            </button>
            <button disabled={pending} onClick={() => decide(p, false)} className="btn btn-ghost">
              Skip
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function WriteSkillForm({ bases }: { bases: string[] }) {
  const close = useCloseForm();
  const { toast } = useShell();
  const [state, action, pending] = useActionState<SkillActionResult, FormData>(async (previous, form) => {
    const result = await saveSkillAction(previous, form);
    if (!result.error) {
      if (result.message) toast(result.message);
      close();
    }
    return result;
  }, {});
  return (
    <form action={action} className="space-y-3 border border-line bg-raised p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <input name="name" required placeholder="month-end-close" pattern="[a-z][a-z0-9-]{1,40}" className="field font-mono" autoFocus />
        <select name="extends" defaultValue="" className="field" aria-label="Extends">
          <option value="">Its own skill</option>
          {bases.map((name) => (
            <option key={name} value={name}>
              Extends {name}
            </option>
          ))}
        </select>
      </div>
      <input name="description" required placeholder="When to use it, e.g. Monthly: close the books for the family entities" className="field" />
      <textarea
        name="body"
        required
        rows={10}
        placeholder={"When to use\nSteps\nRules\nPitfalls\nChecks"}
        className="field font-mono text-xs"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" name="share" /> The company&apos;s (everyone&apos;s agents use it)
        </label>
        <button disabled={pending} className="btn">
          Save skill
        </button>
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

export function CompanySkills({ skills }: { skills: CompanySkillView[] }) {
  return (
    <ul className="space-y-3">
      {skills.map((skill) => (
        <CompanySkillCard key={skill.name} skill={skill} />
      ))}
    </ul>
  );
}

function CompanySkillCard({ skill }: { skill: CompanySkillView }) {
  const { toast } = useShell();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const act = (work: () => Promise<SkillActionResult>) =>
    start(async () => {
      const result = await work();
      toast(result.error ?? result.message ?? "Done");
    });
  return (
    <li id={skill.name} className="border border-line bg-raised">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <ChevronRight size={14} className={`mt-1 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="label mb-0.5 block">
            {skill.kind === "integration" ? "System" : "Workflow"} · v{skill.version}
            {skill.owner ? ` · ${skill.owner}'s` : ""}
            {skill.extends ? ` · extends ${skill.extends}` : ""}
          </span>
          <span className="block font-mono text-sm">{skill.name}</span>
          <span className="mt-0.5 block text-sm text-muted">{skill.description}</span>
        </span>
        <span className="shrink-0 text-xs text-faint">
          <When date={skill.updatedAt} />
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line-soft px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <VisibilityToggle
              visibility={skill.visibility}
              canChange={skill.canChange}
              privateMeans="Only work for its owner uses it"
              change={(next) => shareSkillAction(skill.name, next === "company")}
            />
            {skill.canChange && (
              <button
                disabled={pending}
                onClick={() => confirm(`Retire ${skill.name}? Agents stop using it; its versions are kept.`) && act(() => archiveSkillAction(skill.name))}
                className="btn btn-ghost hover:text-danger"
              >
                Retire
              </button>
            )}
          </div>
          <div className="prose prose-mach prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.body}</ReactMarkdown>
          </div>
          {skill.scripts.length > 0 && (
            <p className="text-xs text-muted">
              Scripts: <span className="font-mono">{skill.scripts.join(", ")}</span>
            </p>
          )}
          <div>
            <p className="label mb-2">Versions</p>
            <ul className="space-y-1.5 text-sm">
              {skill.versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs">v{v.version}</span>
                  <span className="min-w-0 flex-1 text-muted">
                    {v.note || "Saved"}
                    {v.author ? ` · ${v.author}` : ""}
                    {v.taskNumber ? ` · from #${v.taskNumber}` : ""}
                  </span>
                  <span className="text-xs text-faint">
                    <When date={v.at} />
                  </span>
                  {skill.canChange && v.version !== skill.version && (
                    <button disabled={pending} onClick={() => act(() => restoreSkillAction(skill.name, v.version))} className="text-xs text-faint hover:text-ink">
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

export function BaseSkills({ skills }: { skills: BaseSkillView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-line-soft border border-line bg-raised">
      {skills.map((skill) => (
        <li key={skill.name}>
          <button onClick={() => setOpen(open === skill.name ? null : skill.name)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left">
            <ChevronRight size={14} className={`mt-1 shrink-0 text-faint transition-transform ${open === skill.name ? "rotate-90" : ""}`} />
            <span className="min-w-0">
              <span className="block font-mono text-sm">{skill.name}</span>
              <span className="block text-xs text-muted">{skill.description}</span>
            </span>
          </button>
          {open === skill.name && (
            <div className="prose prose-mach prose-sm max-w-none border-t border-line-soft px-4 py-4 sm:px-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.body}</ReactMarkdown>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
