"use client";

import Link from "next/link";

// A few options side by side, one picked: links (the choice is in the URL) or
// buttons. Big enough to tap on a phone.

export type SegmentedOption = { value: string; label: React.ReactNode; title?: string; href?: string };

export function Segmented({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentedOption[];
  value: string;
  onChange?: (value: string) => void;
  /** What the choice is about, for screen readers. */
  label: string;
}) {
  const item = (on: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1 text-[13px] max-md:py-1.5 ${on ? "bg-selected text-ink" : "text-muted hover:text-ink"}`;
  return (
    <div className="flex shrink-0 border border-line" role="group" aria-label={label}>
      {options.map((o) =>
        o.href ? (
          <Link key={o.value} href={o.href} title={o.title} aria-current={value === o.value ? "page" : undefined} className={item(value === o.value)}>
            {o.label}
          </Link>
        ) : (
          <button key={o.value} type="button" onClick={() => onChange?.(o.value)} title={o.title} aria-pressed={value === o.value} className={item(value === o.value)}>
            {o.label}
          </button>
        ),
      )}
    </div>
  );
}
