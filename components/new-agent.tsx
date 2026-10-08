"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { AgentForm } from "@/components/agent-form";
import type { AgentTemplate } from "@/lib/agents/templates";

export function NewAgent({ templates, startOpen }: { templates: AgentTemplate[]; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn">
        <Plus size={15} /> New defined agent
      </button>
    );
  }
  return (
    <section className="frame bg-raised p-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="label">New defined agent</h2>
        <button onClick={() => setOpen(false)} className="label text-faint hover:text-ink">
          Cancel
        </button>
      </div>
      <AgentForm templates={templates} onDone={() => setOpen(false)} />
    </section>
  );
}
