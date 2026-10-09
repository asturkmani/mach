"use client";

import { BadgeCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { createEmailInboxAction, startWhatsAppLinkAction, unlinkWhatsAppAction } from "@/app/(app)/company/actions";
import { SettingRow } from "@/components/setting-row";
import { formatPhone } from "@/lib/phone-format";
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
            The Chief of Staff answers on <span className="font-mono text-ink">{formatPhone(whatsapp)}</span>. Each person links the
            number they message it from in Settings → Account, by sending a one-time code from it.
          </>
        ) : (
          `Not set up for Mach1 yet.${isAdmin ? " It needs a Twilio WhatsApp sender (see docs/channels.md)." : ""}`
        )
      }
    />
  );
}


/**
 * Your WhatsApp: linked by sending a one-time code from your phone to Mach1's
 * number, which proves the number is yours. Only a linked number reaches the
 * Chief of Staff as you.
 */
export function WhatsAppNumber({ whatsapp, linked }: { whatsapp: string | null; linked: string | null }) {
  const { toast } = useShell();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [link, setLink] = useState<{ code: string; expiresAt: string } | null>(null);

  // Waiting for the code to arrive from the phone: check every few seconds until it's linked or expires.
  useEffect(() => {
    if (!link || linked) return;
    const timer = setInterval(() => {
      if (Date.now() > new Date(link.expiresAt).getTime()) setLink(null);
      else router.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [link, linked, router]);
  // The code arrived (the refresh brought the linked number): done waiting.
  if (linked && link) setLink(null);

  const startLink = () =>
    start(async () => {
      const result = await startWhatsAppLinkAction();
      if ("error" in result) toast(result.error);
      else setLink(result);
    });
  const unlink = () =>
    start(async () => {
      if (!confirm("Unlink this number? Messages from it won't reach the Chief of Staff until you link it again.")) return;
      await unlinkWhatsAppAction();
      toast("WhatsApp unlinked");
      router.refresh();
    });

  if (!whatsapp) return <SettingRow title="WhatsApp" description="WhatsApp isn't set up for Mach1 yet." />;
  const digits = whatsapp.replace(/\D/g, "");
  const chat = (
    <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="font-mono text-ink underline underline-offset-2">
      {formatPhone(whatsapp)}
    </a>
  );

  if (linked) {
    return (
      <SettingRow
        title="WhatsApp"
        description={
          <>
            Linked to{" "}
            <span className="inline-flex items-center gap-1 font-mono text-ink">
              {formatPhone(linked)}
              <BadgeCheck size={13} className="text-ok" aria-label="Verified" />
            </span>
            . Message {chat} from it to talk to the Chief of Staff.
          </>
        }
        action={
          <button onClick={unlink} disabled={pending} className="btn">
            Unlink
          </button>
        }
      />
    );
  }

  if (link) {
    const message = `LINK ${link.code}`;
    return (
      <SettingRow
        title="WhatsApp"
        description={
          <span className="block space-y-2">
            <span className="block">
              Send this from the phone you use WhatsApp on, to {chat}. It proves the number is yours. The code works for 10 minutes.
            </span>
            <span className="block font-mono text-lg tracking-wider text-ink">{message}</span>
            <span className="block text-xs text-faint">Waiting for it to arrive…</span>
          </span>
        }
        action={
          <div className="flex gap-2">
            <a href={`https://wa.me/${digits}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer" className="btn btn-primary">
              Open WhatsApp
            </a>
            <button onClick={() => setLink(null)} className="btn btn-ghost">
              Cancel
            </button>
          </div>
        }
      />
    );
  }

  return (
    <SettingRow
      title="WhatsApp"
      description={
        <>
          Talk to the Chief of Staff from WhatsApp. Link your number by sending a one-time code from it, so only you can reach it as you.
          Messages from numbers that aren&apos;t linked aren&apos;t answered.
        </>
      }
      action={
        <button onClick={startLink} disabled={pending} className="btn">
          Link WhatsApp
        </button>
      }
    />
  );
}
