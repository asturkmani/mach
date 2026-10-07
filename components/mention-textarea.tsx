"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import { Face } from "@/components/ui";

// A textarea that suggests people and agents after "@". Arrow keys move,
// Enter or Tab picks, Escape closes; picking writes "@Full Name ".

export type MentionCandidate = { id: string; name: string; kind: "person" | "agent"; detail?: string };

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  candidates: MentionCandidate[];
};

/** The "@partial" right before the caret, if the person is typing a mention. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(?:^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30}){0,2})$/);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea(
  { value, onValueChange, candidates, onKeyDown, ...props },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);
  const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
  const [cursor, setCursor] = useState(0);

  const query = open?.query.toLowerCase() ?? "";
  // The whole name starts with what's typed, or (for one word) any of its words does.
  const matches = open
    ? candidates
        .filter((c) => {
          const name = c.name.toLowerCase();
          return name.startsWith(query) || (!query.includes(" ") && name.split(/\s+/).some((word) => word.startsWith(query)));
        })
        .slice(0, 6)
    : [];
  const index = Math.min(cursor, Math.max(0, matches.length - 1));

  const update = (text: string, caret: number) => {
    onValueChange(text);
    setOpen(mentionAt(text, caret));
    setCursor(0);
  };

  const pick = (candidate: MentionCandidate) => {
    if (!open || !inner.current) return;
    const caret = inner.current.selectionStart;
    const text = `${value.slice(0, open.start)}@${candidate.name} ${value.slice(caret)}`;
    const at = open.start + candidate.name.length + 2;
    onValueChange(text);
    setOpen(null);
    requestAnimationFrame(() => inner.current?.setSelectionRange(at, at));
  };

  return (
    <div className="relative">
      <textarea
        {...props}
        ref={inner}
        value={value}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onClick={(e) => setOpen(mentionAt(value, e.currentTarget.selectionStart))}
        onBlur={() => setTimeout(() => setOpen(null), 150)}
        onKeyDown={(e) => {
          if (open && matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((index + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
              e.preventDefault();
              pick(matches[index]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {open && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute bottom-full left-3 z-20 mb-1 w-72 border border-line bg-raised py-1 shadow-[var(--shadow)]"
        >
          {matches.map((c, i) => (
            <li key={`${c.kind}-${c.id}`} role="option" aria-selected={i === index}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseMove={() => setCursor(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === index ? "bg-selected" : ""}`}
              >
                <Face name={c.name} agent={c.kind === "agent"} size={18} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="label text-[10px] text-faint">{c.kind === "agent" ? c.detail || "Agent" : c.detail || "Person"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
