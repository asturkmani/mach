import "server-only";

import { chiefOfStaffTurn } from "@/lib/agents/cos-turn";
import { appUrl } from "@/lib/app-url";
import { replyToEmail } from "@/lib/channels/agentmail";
import { findByEmail, findByPhone } from "@/lib/channels/senders";
import { completeWhatsAppLink, LINK_MESSAGE } from "@/lib/channels/whatsapp-links";
import { fetchTwilioMedia, sendWhatsApp } from "@/lib/channels/twilio";
import { findOrganizationByInbox } from "@/lib/orgs";
import { MAX_AUDIO_BYTES, transcribeAudio } from "@/lib/transcribe";
import type { LanguageModel, TranscriptionModel } from "ai";

// What happens to a WhatsApp message or an email once its webhook has been
// checked: find who sent it, run the Chief of Staff on it in their
// conversation, and send the reply back the same way.

type TurnOptions = { model?: LanguageModel; research?: boolean; transcriber?: TranscriptionModel };

const trouble = () => `Sorry, something went wrong on my side. Try again, or open Mach1: ${appUrl("/")}`;

export type WhatsAppMessage = {
  from: string;
  body: string;
  media: number;
  /** The first attachment, which is a voice note when its type is audio. */
  mediaUrl?: string;
  mediaType?: string;
};

/** A voice note, as words; null when it can't be heard. */
async function voiceNote(message: WhatsAppMessage, transcriber?: TranscriptionModel): Promise<string | null> {
  if (!message.mediaUrl) return null;
  try {
    const audio = await fetchTwilioMedia(message.mediaUrl, MAX_AUDIO_BYTES);
    return (await transcribeAudio(audio, { model: transcriber })) || null;
  } catch (error) {
    console.error("WhatsApp voice note couldn't be transcribed", error);
    return null;
  }
}

export async function handleWhatsApp(message: WhatsAppMessage, options: TurnOptions = {}): Promise<void> {
  // "LINK <code>" from the phone proves the number is theirs (see whatsapp-links.ts).
  if (LINK_MESSAGE.test(message.body)) {
    const result = await completeWhatsAppLink(message.body, message.from);
    await sendWhatsApp(
      message.from,
      result.linked
        ? `Linked. This number now reaches the Chief of Staff as ${result.personName} at ${result.companyName}. Message me here any time.`
        : `That code didn't work or has expired. Get a new one in Mach1: ${appUrl("/settings/account")} → WhatsApp → Link.`,
    );
    return;
  }
  const context = await findByPhone(message.from);
  if (!context) {
    await sendWhatsApp(
      message.from,
      `Hi, this is Mach1's Chief of Staff. This number isn't linked to anyone in Mach1 yet. To link it, open ${appUrl("/settings/account")}, choose Link WhatsApp, and send me the code it shows, from this phone.`,
    );
    return;
  }
  const voice = message.mediaType?.startsWith("audio/") ?? false;
  const spoken = voice ? await voiceNote(message, options.transcriber) : null;
  const notes: string[] = [];
  if (spoken) notes.push(`${spoken}\n\n[Sent as a voice note and transcribed: names and numbers may be off, so check anything that matters before acting on it.]`);
  else if (voice) notes.push("[They sent a voice note that couldn't be transcribed. Ask them to try again or type it.]");
  const others = message.media - (voice ? 1 : 0);
  if (others > 0) {
    notes.push(`[They sent ${others} ${voice ? "more " : ""}attachment${others === 1 ? "" : "s"} by WhatsApp, which you can't open here. Ask them to attach it on a task in Mach1 if it matters.]`);
  }
  const text = [message.body.trim(), ...notes].filter(Boolean).join("\n\n");
  if (!text) return;
  let reply: string;
  try {
    reply = await chiefOfStaffTurn(context, text, "whatsapp", { model: options.model, research: options.research });
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
  // Only people on the team who use Mach1; anyone else gets no answer (and no backscatter).
  const context = await findByEmail(organization, email.from);
  if (!context) return;
  // extracted_text is the new part of the email, without the quoted thread below it.
  const body = (email.extracted_text || email.text || email.preview || "").trim();
  const files = (email.attachments ?? []).map((a) => a.filename).filter(Boolean);
  const text = [
    email.subject ? `Subject: ${email.subject}` : "",
    body,
    files.length ? `[Attached: ${files.join(", ")}. You can't open email attachments here; ask them to attach files on a task in Mach1.]` : "",
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
