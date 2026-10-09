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
  moved = false,
}: {
  emailInbox: string | null;
  /** The company's old address belonged to an email account Mach1 no longer uses. */
  moved?: boolean;
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
            from {email || "your email address in Mach1"}. It replies in the same thread.
          </>
        ) : !emailAvailable ? (
          `Not set up for Mach1 yet.${isAdmin ? " It needs an AgentMail API key (see docs/channels.md)." : ""}`
        ) : isAdmin ? (
          moved
            ? "Mach1 moved to a new email account, so the old address no longer works. Set up a new one for your team."
            : "Give the Chief of Staff an address your team can write to."
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
            The Chief of Staff answers on <span className="font-mono text-ink">{formatPhone(whatsapp)}</span>. Each person saves
            the number they message it from in Settings → Account.
          </>
        ) : (
          `Not set up for Mach1 yet.${isAdmin ? " It needs a Twilio WhatsApp sender (see docs/channels.md)." : ""}`
        )
      }
    />
  );
}

/** A WhatsApp number as people write it: +44 7403 932000 for UK numbers, otherwise as given. */
export function formatPhone(number: string): string {
  const raw = number.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  const uk = raw.match(/^\+44(\d{4})(\d{6})$/);
  return uk ? `+44 ${uk[1]} ${uk[2]}` : raw;
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

  const linked = phone?.trim() ? phone : null;
  const chat = whatsapp ? (
    <a
      href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-ink underline underline-offset-2"
    >
      {formatPhone(whatsapp)}
    </a>
  ) : null;

  return (
    <SettingRow
      title="WhatsApp"
      description={
        !whatsapp ? (
          "WhatsApp isn't set up for this company yet."
        ) : linked ? (
          <>
            Linked to <span className="font-mono text-ink">{formatPhone(linked)}</span>. Message {chat} from it to talk to the
            Chief of Staff.
          </>
        ) : (
          <>
            Save the number you use WhatsApp on, with its country code, so the Chief of Staff knows it&apos;s you. Then message{" "}
            {chat} from it. Messages from numbers that aren&apos;t saved here aren&apos;t answered.
          </>
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
              aria-label="Your WhatsApp number, with its country code"
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
