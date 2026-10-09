import { after } from "next/server";

import { handleWhatsApp } from "@/lib/channels/inbound";
import { firstTime } from "@/lib/channels/senders";
import { twilioConfigured, validTwilioSignature } from "@/lib/channels/twilio";

// Twilio posts each WhatsApp message here. The Chief of Staff can take longer
// than Twilio waits for an answer, so it replies through Twilio's API after
// this request has returned.
export const maxDuration = 800;

/** The URL Twilio signed: what it was configured with, behind Vercel's proxy. */
function signedUrl(request: Request): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}${url.pathname}${url.search}`;
}

const empty = () => new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });

export async function POST(request: Request) {
  if (!twilioConfigured()) return new Response("WhatsApp isn't set up.", { status: 404 });
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  if (!validTwilioSignature(signedUrl(request), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Bad signature.", { status: 403 });
  }
  if (!params.From || (params.MessageSid && !(await firstTime("twilio", params.MessageSid)))) return empty();
  const message = {
    from: params.From.replace(/^whatsapp:/, ""),
    body: params.Body ?? "",
    media: Number(params.NumMedia ?? 0),
    mediaUrl: params.MediaUrl0,
    mediaType: params.MediaContentType0,
  };
  after(() => handleWhatsApp(message).catch((error) => console.error("WhatsApp reply failed", error)));
  return empty();
}
