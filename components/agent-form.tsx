"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { createAgentAction, setAgentStatusAction, updateAgentAction, type AgentActionResult } from "@/app/(app)/agents/actions";
import type { AgentStatus } from "@/lib/agents/store";
import type { AgentTemplate } from "@/lib/agents/templates";

type Values = { name: string; role: string; description: string; instructions: string };
const EMPTY: Values = { name: "", role: "", description: "", instructions: "" };

export function AgentForm({
  agentId,
  initial = EMPTY,
  templates = [],
  onDone,
}: {
  agentId?: string;
  initial?: Values;
  templates?: AgentTemplate[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(initial);
  const [state, action, pending] = useActionState<AgentActionResult, FormData>(
    agentId ? updateAgentAction.bind(null, agentId) : createAgentAction,
    {},
  );

  useEffect(() => {
    if (state.id && !state.error && !agentId) {
      onDone?.();
      router.push(`/agents/${state.id}`);
    }
  }, [state, agentId, onDone, router]);

  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues({ ...values, [key]: e.target.value });

  return (
    <form action={action} className="space-y-4">
      {templates.length > 0 && (
        <div className="space-y-2">
          <p className="label">Start from</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => setValues(t)}
                className={`border px-2.5 py-1 text-sm ${values.name === t.name ? "border-ink bg-selected" : "border-line text-muted hover:text-ink"}`}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="label">Name</span>
          <input name="name" required value={values.name} onChange={set("name")} className="field" placeholder="Sales outbound" />
        </label>
        <label className="space-y-1.5">
          <span className="label">Role</span>
          <input name="role" value={values.role} onChange={set("role")} className="field" placeholder="Outbound sales" />
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="label">Job description</span>
        <textarea
          name="description"
          rows={3}
          value={values.description}
          onChange={set("description")}
          className="field resize-y"
          placeholder="What it's responsible for and what good work looks like."
        />
      </label>
      <label className="block space-y-1.5">
        <span className="label">Instructions</span>
        <textarea
          name="instructions"
          rows={5}
          value={values.instructions}
          onChange={set("instructions")}
          className="field resize-y font-mono text-[13px]"
          placeholder="Do's and don'ts, sources, tone, formats."
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : agentId ? "Save" : "Create agent"}
        </button>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
        {agentId && state.id && !state.error && !pending && <p className="text-sm text-ok">Saved.</p>}
      </div>
    </form>
  );
}

export function AgentStatusControl({ agentId, status }: { agentId: string; status: AgentStatus }) {
  const [pending, setPending] = useState(false);
  const set = async (next: AgentStatus) => {
    setPending(true);
    await setAgentStatusAction(agentId, next);
    setPending(false);
  };
  return (
    <div className="flex gap-2">
      {status === "active" && (
        <button className="btn" disabled={pending} onClick={() => set("paused")}>
          Pause
        </button>
      )}
      {status !== "active" && (
        <button className="btn" disabled={pending} onClick={() => set("active")}>
          {status === "archived" ? "Restore" : "Resume"}
        </button>
      )}
      {status !== "archived" && (
        <button className="btn btn-ghost" disabled={pending} onClick={() => confirm("Archive this agent?") && set("archived")}>
          Archive
        </button>
      )}
    </div>
  );
}
