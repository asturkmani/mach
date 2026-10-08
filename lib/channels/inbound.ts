import "server-only";

import { chiefOfStaffTurn } from "@/lib/agents/cos-turn";
import { appUrl } from "@/lib/app-url";
import { replyToEmail } from "@/lib/channels/agentmail";
import { findByEmail, findByPhone } from "@/lib/channels/senders";
import { sendWhatsApp } from "@/lib/channels/twilio";
import { findOrganizationByInbox } from "@/lib/orgs";
import type { LanguageModel } from "ai";

// What happens to a WhatsApp message or an email once its webhook has been
// checked: find who sent it, run the Chief of Staff on it in their
// conversation, and send the reply back the same way.

type TurnOptions = { model?: LanguageModel; research?: boolean };

const trouble = () => `Sorry, something went wrong on my side. Try again, or open Mach: ${appUrl("/")}`;

export type WhatsAppMessage = { from: string; body: string; media: number };

export async function handleWhatsApp(message: WhatsAppMessage, options: TurnOptions = {}): Promise<void> {
  const context = await findByPhone(message.from);
  if (!context) {
    await sendWhatsApp(
      message.from,
      `Hi, this is Mach's Chief of Staff. This number isn't linked to anyone in Mach yet: sign in at ${appUrl("/company")} and add it as your WhatsApp number, then message me again.`,
    );
    return;
  }
  const attached = message.media ? `\n\n[They sent ${message.media} attachment${message.media === 1 ? "" : "s"} by WhatsApp, which you can't open here. Ask them to attach it on a task in Mach if it matters.]` : "";
  const text = `${message.body.trim()}${attached}`.trim();
  if (!text) return;
  let reply: string;
  try {
    reply = await chiefOfStaffTurn(context, text, "whatsapp", options);
  } catch (error) {
    console.error("WhatsApp turn failed", error);
    reply = trouble();
  }
  await sendWhatsApp(message.from, reply);
}

/** The parts of AgentMail's message.received event used here. */
export type ReceivedEmail = {
  inbox_id: string;
  message_id: string;
  from: string;
  subject?: string;
  text?: string;
  extracted_text?: string;
  preview?: string;
  attachments?: { filename?: string }[];
};

export async function handleEmail(email: ReceivedEmail, options: TurnOptions = {}): Promise<void> {
  const organization = await findOrganizationByInbox(email.inbox_id);
  if (!organization) return;
  // Only people on the team who use Mach; anyone else gets no answer (and no backscatter).
  const context = await findByEmail(organization, email.from);
  if (!context) return;
  // extracted_text is the new part of the email, without the quoted thread below it.
  const body = (email.extracted_text || email.text || email.preview || "").trim();
  const files = (email.attachments ?? []).map((a) => a.filename).filter(Boolean);
  const text = [
    email.subject ? `Subject: ${email.subject}` : "",
    body,
    files.length ? `[Attached: ${files.join(", ")}. You can't open email attachments here; ask them to attach files on a task in Mach.]` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!text) return;
  let reply: string;
  try {
    reply = await chiefOfStaffTurn(context, text, "email", options);
  } catch (error) {
    console.error("Email turn failed", error);
    reply = trouble();
  }
  await replyToEmail(email.inbox_id, email.message_id, reply);
}
