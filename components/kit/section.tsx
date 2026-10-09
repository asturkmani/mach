"use client";

import { Plus } from "lucide-react";
import { createContext, useContext, useState } from "react";

// A part of a page: its heading and count, a button that opens its add form in
// place, and its content. The form closes itself once it's done (useCloseForm).

const CloseForm = createContext<() => void>(() => {});

/** For a section's add form: closes it (after adding, say). */
export const useCloseForm = () => useContext(CloseForm);

export function Section({
  title,
  count,
  description,
  addLabel,
  startOpen = false,
  form,
  children,
}: {
  title: string;
  count?: number;
  description?: React.ReactNode;
  addLabel?: string;
  startOpen?: boolean;
  /** Shown above the content while open, in place of the add button. */
  form?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="label">
          {title} {count !== undefined && <span className="text-faint">{count}</span>}
        </h2>
        {form &&
          (open ? (
            <button onClick={() => setOpen(false)} className="btn btn-ghost">
              Cancel
            </button>
          ) : (
            <button onClick={() => setOpen(true)} className="btn">
              <Plus size={14} /> {addLabel}
            </button>
          ))}
      </div>
      {description && <div className="-mt-1 mb-3 text-sm text-muted">{description}</div>}
      {open && form && (
        <div className="mb-4">
          <CloseForm.Provider value={() => setOpen(false)}>{form}</CloseForm.Provider>
        </div>
      )}
      {children}
    </section>
  );
}
