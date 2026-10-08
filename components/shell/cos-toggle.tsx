"use client";

import { MessageSquare } from "lucide-react";

import { useShell } from "./shell";

/** Opens and closes the Chief of Staff panel, at the right of a page's header. On a phone it's in the bottom bar. */
export function CosToggle() {
  const { cosOpen, setCosOpen } = useShell();
  return (
    <button
      onClick={() => setCosOpen(!cosOpen)}
      title={cosOpen ? "Hide the Chief of Staff (C)" : "Open the Chief of Staff (C)"}
      aria-pressed={cosOpen}
      className={`btn btn-ghost ml-1 hidden md:inline-flex ${cosOpen ? "bg-selected text-ink" : ""}`}
    >
      <MessageSquare size={15} strokeWidth={1.6} />
      <span className="hidden lg:inline">Chief of Staff</span>
    </button>
  );
}
