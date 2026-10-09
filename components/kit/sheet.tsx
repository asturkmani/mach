"use client";

import { X } from "lucide-react";

// A dialog: a sheet that rises from the bottom on a phone (where thumbs are),
// a box near the top on a computer. Escape, the backdrop and the cross close it.

export function Sheet({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[55] flex items-end justify-center bg-black/30 md:items-start md:px-4 md:pt-[10vh]"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        className={`frame w-full bg-raised shadow-[var(--shadow)] enter-sheet max-md:max-h-[88%] max-md:overflow-y-auto max-md:rounded-t-lg max-md:px-5 max-md:pt-4 max-md:pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:p-6 ${wide ? "md:max-w-2xl" : "md:max-w-md"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line md:hidden" aria-hidden />
        <div className="mb-5 flex items-center justify-between">
          <h2 className="label">{title}</h2>
          <button onClick={onClose} className="-m-2 p-2 text-faint hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
