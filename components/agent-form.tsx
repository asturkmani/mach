"use client";

import { useActionState, useState } from "react";

import { setAgentStatusAction, updateAgentAction, type AgentActionResult } from "@/app/(app)/agents/actions";
import type { AgentStatus } from "@/lib/agents/store";

type Values = { name: string; role: string; description: string; instructions: string; model?: string };
const EMPTY: Values = { name: "", role: "", description: "", instructions: "" };
type ModelOption = { id: string; name: string };

/** Editing one of Mach1's agents: its name, role, instructions and model. Companies don't make agents of their own: they keep skills. */
export function AgentForm({
  agentId,
  initial = EMPTY,
  models,
}: {
  agentId: string;
  initial?: Values;
  /** Offered when editing: the models to choose from, and what it runs on without one. */
  models?: { choices: ModelOption[]; fallback: string };
}) {
  const [values, setValues] = useState<Values>(initial);
  const [state, action, pending] = useActionState<AgentActionResult, FormData>(
    updateAgentAction.bind(null, agentId),
    {},
  );

  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues({ ...values, [key]: e.target.value });

  return (
    <form action={action} className="space-y-4">
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
      {models && (
        <label className="block space-y-1.5">
          <span className="label">Model</span>
          <input
            name="model"
            list="agent-models"
            value={values.model ?? ""}
            onChange={set("model")}
            className="field font-mono text-[13px]"
            placeholder={models.fallback ? `Default: ${models.fallback}` : "provider/model"}
          />
          <datalist id="agent-models">
            {models.choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
          <span className="block text-xs text-faint">
            Pick one that suits its work: a strong coding model for a developer, a cheaper one for routine jobs. Empty uses the default.
          </span>
        </label>
      )}
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
