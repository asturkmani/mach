"use client";

import { Mail, MessageCircle } from "lucide-react";
import { useState, useTransition } from "react";

import { createEmailInboxAction, savePhoneAction } from "@/app/(app)/company/actions";
import { useShell } from "@/components/shell/shell";

// How to reach the Chief of Staff outside the app: WhatsApp from your own
// number, and email to the company's address. It's the same conversation as
// the chat panel.

export function ReachChiefOfStaff({
  whatsapp,
  phone,
  emailInbox,
  email,
  emailAvailable,
  isAdmin,
}: {
  /** Mach's WhatsApp number, or null when WhatsApp isn't set up. */
  whatsapp: string | null;
  /** This person's own number. */
  phone: string | null;
  emailInbox: string | null;
  /** This person's own email address. */
  email: string;
  /** Whether email can be set up (AgentMail is configured). */
  emailAvailable: boolean;
  isAdmin: boolean;
}) {
  const { toast } = useShell();
  const [saving, startSaving] = useTransition();
  const [creating, startCreating] = useTransition();
  const [number, setNumber] = useState(phone ?? "");

  const savePhone = () =>
    startSaving(async () => {
      const result = await savePhoneAction(number);
      toast(result.error ?? (number.trim() ? "Saved your WhatsApp number" : "Removed your WhatsApp number"));
    });
  const createInbox = () =>
    startCreating(async () => {
      const result = await createEmailInboxAction();
      if (result.error) toast(result.error);
    });

  return (
    <section className="mx-auto mt-14 max-w-3xl">
      <h2 className="text-[15px]">Talk to the Chief of Staff from anywhere</h2>
      <p className="mt-0.5 text-sm text-muted">The same conversation as the chat panel, from your phone or your inbox.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="border border-line bg-raised px-4 py-4">
          <p className="label mb-2 flex items-center gap-2">
            <MessageCircle size={13} /> WhatsApp
          </p>
          {whatsapp ? (
            <>
              <p className="text-sm">
                Message{" "}
                <a href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
                  {whatsapp}
                </a>{" "}
                from your number:
              </p>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  savePhone();
                }}
              >
                <input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+44 7700 900123"
                  aria-label="Your WhatsApp number"
                  className="field min-w-0 flex-1 font-mono text-sm"
                />
                <button type="submit" disabled={saving || number.trim() === (phone ?? "")} className="btn">
                  Save
                </button>
              </form>
              <p className="mt-2 text-xs text-faint">With the country code. Only numbers saved here get answers.</p>
            </>
          ) : (
            <p className="text-sm text-muted">Not set up for Mach yet.{isAdmin ? " It needs a Twilio WhatsApp sender (see docs/channels.md)." : ""}</p>
          )}
        </div>
        <div className="border border-line bg-raised px-4 py-4">
          <p className="label mb-2 flex items-center gap-2">
            <Mail size={13} /> Email
          </p>
          {emailInbox ? (
            <>
              <p className="text-sm">
                Write to{" "}
                <a href={`mailto:${emailInbox}`} className="font-mono underline underline-offset-2 break-all">
                  {emailInbox}
                </a>
              </p>
              <p className="mt-2 text-xs text-faint">From {email || "your email address in Mach"}. It replies in the same thread.</p>
            </>
          ) : emailAvailable ? (
            isAdmin ? (
              <>
                <p className="text-sm text-muted">Give the Chief of Staff an email address your team can write to.</p>
                <button onClick={createInbox} disabled={creating} className="btn mt-3">
                  {creating ? "Creating…" : "Create an email address"}
                </button>
              </>
            ) : (
              <p className="text-sm text-muted">An admin can give the Chief of Staff an email address here.</p>
            )
          ) : (
            <p className="text-sm text-muted">Not set up for Mach yet.{isAdmin ? " It needs an AgentMail API key (see docs/channels.md)." : ""}</p>
          )}
        </div>
      </div>
    </section>
  );
}
