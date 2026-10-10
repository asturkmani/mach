import "server-only";

import { catchUpConversation, chiefOfStaffTurn } from "@/lib/agents/cos-turn";
import { recordWhatsAppIn } from "@/lib/assistant/store";
import { appUrl } from "@/lib/app-url";
import { fetchEmailAttachment, replyToEmail } from "@/lib/channels/agentmail";
import { keepIncomingFiles, nameFor, type IncomingFile } from "@/lib/channels/inbound-files";
import { MAX_FILE_BYTES } from "@/lib/files";
import { findByEmail, findByPhone } from "@/lib/channels/senders";
import { completeWhatsAppLink, LINK_MESSAGE } from "@/lib/channels/whatsapp-links";
import { fetchTwilioMedia, keepTyping, sendWhatsApp, showTyping } from "@/lib/channels/twilio";
import { findOrganizationByInbox } from "@/lib/orgs";
import { MAX_AUDIO_BYTES, transcribeAudio } from "@/lib/transcribe";
import type { LanguageModel, TranscriptionModel } from "ai";

// What happens to a WhatsApp message or an email once its webhook has been
// checked: find who sent it, run the Chief of Staff on it in their
// conversation, and send the reply back the same way.

type TurnOptions = { model?: LanguageModel; research?: boolean; transcriber?: TranscriptionModel };

const trouble = () => `Sorry, something went wrong on my side. Try again, or open Mach1: ${appUrl("/")}`;

export type WhatsAppMessage = {
  /** Twilio's id for it (SM…), to mark it read. */
  sid?: string;
  from: string;
  body: string;
  media: number;
  /** The first attachment, which is a voice note when its type is audio. */
  mediaUrl?: string;
  mediaType?: string;
  /** Every attachment (Twilio's MediaUrlN and MediaContentTypeN). */
  attachments?: { url: string; type: string }[];
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
  // Blue ticks and "typing…" straight away, until the reply goes out.
  const stopTyping = keepTyping(message.sid);
  // WhatsApp's 24 hours, in which their assistant may write first, start again.
  await recordWhatsAppIn(context.organization.id, context.person.id);
  const voice = message.mediaType?.startsWith("audio/") ?? false;
  const spoken = voice ? await voiceNote(message, options.transcriber) : null;
  const notes: string[] = [];
  if (spoken) notes.push(`${spoken}\n\n[Sent as a voice note and transcribed: names and numbers may be off, so check anything that matters before acting on it.]`);
  else if (voice) notes.push("[They sent a voice note that couldn't be transcribed. Ask them to try again or type it.]");
  // Everything else they sent (photos, PDFs, spreadsheets…) goes into their files, and to you with the message.
  const incoming: IncomingFile[] = [];
  const failed: number[] = [];
  const attachments = (message.attachments ?? (message.mediaUrl ? [{ url: message.mediaUrl, type: message.mediaType ?? "" }] : [])).slice(voice ? 1 : 0);
  for (const [i, file] of attachments.entries()) {
    try {
      const bytes = Buffer.from(await fetchTwilioMedia(file.url, MAX_FILE_BYTES));
      incoming.push({ name: nameFor(file.type, i), contentType: file.type || "application/octet-stream", bytes });
    } catch (error) {
      console.error("Couldn't fetch a WhatsApp attachment", (error as Error).message);
      failed.push(i);
    }
  }
  if (failed.length) notes.push(`[${failed.length} of the files they sent couldn't be fetched (too big, or WhatsApp didn't hand it over). Ask them to send it again or add it in Mach1.]`);
  const files = await keepIncomingFiles(context.organization.id, context.person.id, incoming);
  const text = [message.body.trim(), ...notes].filter(Boolean).join("\n\n") || (files.length ? "[They sent the attached file without a message.]" : "");
  if (!text) return stopTyping();
  let reply: string;
  try {
    reply = await chiefOfStaffTurn(context, text, "whatsapp", {
      model: options.model,
      research: options.research,
      files,
      // "On it…" goes out before longer work; "typing…" carries on after it.
      acknowledge: async (ack) => {
        await sendWhatsApp(message.from, ack);
        if (message.sid) await showTyping(message.sid);
      },
    });
  } catch (error) {
    console.error("WhatsApp turn failed", error);
    reply = trouble();
  } finally {
    stopTyping();
  }
  if (reply) await sendWhatsApp(message.from, reply);
  await catchUpConversation(context);
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
  attachments?: { attachment_id?: string; filename?: string; content_type?: string; size?: number }[];
};

export async function handleEmail(email: ReceivedEmail, options: TurnOptions = {}): Promise<void> {
  const organization = await findOrganizationByInbox(email.inbox_id);
  if (!organization) return;
  // Only people on the team who use Mach1; anyone else gets no answer (and no backscatter).
  const context = await findByEmail(organization, email.from);
  if (!context) return;
  // extracted_text is the new part of the email, without the quoted thread below it.
  const body = (email.extracted_text || email.text || email.preview || "").trim();
  // Attachments go into their files, and to you with the message.
  const incoming: IncomingFile[] = [];
  const missed: string[] = [];
  for (const attachment of email.attachments ?? []) {
    if (!attachment.attachment_id) continue;
    try {
      const fetched = await fetchEmailAttachment(email.inbox_id, email.message_id, attachment.attachment_id, MAX_FILE_BYTES);
      incoming.push({ name: fetched.filename, contentType: fetched.contentType, bytes: fetched.bytes });
    } catch (error) {
      console.error("Couldn't fetch an email attachment", (error as Error).message);
      missed.push(attachment.filename ?? "an attachment");
    }
  }
  const files = await keepIncomingFiles(context.organization.id, context.person.id, incoming);
  const text = [
    email.subject ? `Subject: ${email.subject}` : "",
    body,
    missed.length ? `[Couldn't fetch: ${missed.join(", ")} (too big, or the mail service didn't hand it over). Ask them to add it in Mach1.]` : "",
  ]
    .filter(Boolean)
    .join("\n\n") || (files.length ? "[They sent the attached files without a message.]" : "");
  if (!text) return;
  let reply: string;
  try {
    reply = await chiefOfStaffTurn(context, text, "email", {
      ...options,
      files,
      acknowledge: (ack) => replyToEmail(email.inbox_id, email.message_id, ack).then(() => undefined),
    });
  } catch (error) {
    console.error("Email turn failed", error);
    reply = trouble();
  }
  if (reply) await replyToEmail(email.inbox_id, email.message_id, reply);
  await catchUpConversation(context);
}
