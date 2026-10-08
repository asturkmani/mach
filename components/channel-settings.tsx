"use client";

import { useState, useTransition } from "react";

import { createEmailInboxAction, savePhoneAction } from "@/app/(app)/company/actions";
import { SettingRow } from "@/components/setting-row";
import { useShell } from "@/components/shell/shell";

// Reaching the Chief of Staff outside the app. The company's email address and
// WhatsApp sender are in Settings → Channels; your own WhatsApp number is in
// Settings → Account. It's the same conversation as the chat panel.

/** The company's Chief of Staff address. */
export function EmailChannel({
  emailInbox,
  email,
  emailAvailable,
  isAdmin,
}: {
  emailInbox: string | null;
  /** This person's own email address, the one replies go to. */
  email: string;
  /** Whether email can be set up (AgentMail is configured). */
  emailAvailable: boolean;
  isAdmin: boolean;
}) {
  const { toast } = useShell();
  const [creating, startCreating] = useTransition();
  const createInbox = () =>
    startCreating(async () => {
      const result = await createEmailInboxAction();
      if (result.error) toast(result.error);
    });
  const copyInbox = async () => {
    if (!emailInbox) return;
    await navigator.clipboard.writeText(emailInbox);
    toast("Copied the address");
  };

  return (
    <SettingRow
      title="Email"
      description={
        emailInbox ? (
          <>
            Write to{" "}
            <a href={`mailto:${emailInbox}`} className="font-mono text-ink underline underline-offset-2 break-all">
              {emailInbox}
            </a>{" "}
            from {email || "your email address in Mach"}. It replies in the same thread.
          </>
        ) : !emailAvailable ? (
          `Not set up for Mach yet.${isAdmin ? " It needs an AgentMail API key (see docs/channels.md)." : ""}`
        ) : isAdmin ? (
          "Give the Chief of Staff an address your team can write to."
        ) : (
          "An admin can give the Chief of Staff an address your team can write to."
        )
      }
      action={
        emailInbox ? (
          <button onClick={copyInbox} className="btn">
            Copy
          </button>
        ) : emailAvailable && isAdmin ? (
          <button onClick={createInbox} disabled={creating} className="btn">
            {creating ? "Creating…" : "Create address"}
          </button>
        ) : undefined
      }
    />
  );
}

/** The company's WhatsApp sender: whether there is one. People link their own number in Account. */
export function WhatsAppChannel({ whatsapp, isAdmin }: { whatsapp: string | null; isAdmin: boolean }) {
  return (
    <SettingRow
      title="WhatsApp"
      description={
        whatsapp ? (
          <>
            Mach&apos;s number is <span className="font-mono text-ink">{whatsapp}</span>. Each person links their own number in
            Account settings.
          </>
        ) : (
          `Not set up for Mach yet.${isAdmin ? " It needs a Twilio WhatsApp sender (see docs/channels.md)." : ""}`
        )
      }
    />
  );
}

/** Your own WhatsApp number, the one the Chief of Staff answers. */
export function WhatsAppNumber({ whatsapp, phone }: { whatsapp: string | null; phone: string | null }) {
  const { toast } = useShell();
  const [saving, startSaving] = useTransition();
  const [number, setNumber] = useState(phone ?? "");
  const savePhone = () =>
    startSaving(async () => {
      const result = await savePhoneAction(number);
      toast(result.error ?? (number.trim() ? "Saved your WhatsApp number" : "Removed your WhatsApp number"));
    });

  return (
    <SettingRow
      title="WhatsApp number"
      description={
        whatsapp ? (
          <>
            Message{" "}
            <a
              href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-ink underline underline-offset-2"
            >
              {whatsapp}
            </a>{" "}
            from this number, with its country code. Only saved numbers get answers.
          </>
        ) : (
          "WhatsApp isn't set up for this company yet."
        )
      }
      action={
        whatsapp ? (
          <form
            className="flex gap-2"
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
              className="field w-44 font-mono text-sm"
            />
            <button type="submit" disabled={saving || number.trim() === (phone ?? "")} className="btn">
              Save
            </button>
          </form>
        ) : undefined
      }
    />
  );
}
