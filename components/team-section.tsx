"use client";

import { Plus } from "lucide-react";
import { createContext, useContext, useState } from "react";

const CloseForm = createContext<() => void>(() => {});

/** For a section's add form: closes it (after adding, say). */
export const useCloseForm = () => useContext(CloseForm);

/** A part of the Team page (people, agents): its heading, a button that opens its add form, and its list. */
export function TeamSection({
  title,
  count,
  addLabel,
  startOpen = false,
  form,
  children,
}: {
  title: string;
  count: number;
  addLabel: string;
  startOpen?: boolean;
  /** Shown in place of the button while open. */
  form?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="label">
          {title} <span className="text-faint">{count}</span>
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
      {open && form && (
        <div className="mb-4">
          <CloseForm.Provider value={() => setOpen(false)}>{form}</CloseForm.Provider>
        </div>
      )}
      {children}
    </section>
  );
}
