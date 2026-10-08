import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// WhatsApp through Twilio: one Mach-wide WhatsApp sender. Twilio posts each
// incoming message to /api/whatsapp, signed with the account's auth token,
// and replies go out through its Messages API.

export const twilioConfigured = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);

/** The WhatsApp number people message, e.g. "+14155238886", or null when WhatsApp isn't set up. */
export function whatsappNumber(): string | null {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  return twilioConfigured() && from ? from.replace(/^whatsapp:/, "") : null;
}

/**
 * Twilio's request signature: HMAC-SHA1 (auth token) of the full webhook URL
 * followed by every posted parameter, sorted by name, as name then value.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const expected = Buffer.from(twilioSignature(url, params, token));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Markdown as WhatsApp shows it: *bold*, _italic_, links spelled out, no headings or tables. */
export function whatsappText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => (label === href ? href : `${label} (${href})`))
    .replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/gm, "")
    .replace(/^\|(.+)\|$/gm, (_, row: string) => row.split("|").map((c) => c.trim()).join(" · "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** WhatsApp messages through Twilio are capped at 1,600 characters: split at paragraphs, then lines. */
export function splitMessage(text: string, max = 1500): string[] {
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n/)) {
    const pieces = paragraph.length > max ? paragraph.match(new RegExp(`[\\s\\S]{1,${max}}`, "g"))! : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + 2 + piece.length > max) {
        parts.push(current);
        current = piece;
      } else current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Sends a WhatsApp message (in as many parts as it takes) to a number like "+447700900123". */
export async function sendWhatsApp(to: string, text: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  for (const body of splitMessage(whatsappText(text))) {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        From: process.env.TWILIO_WHATSAPP_FROM!.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_FROM! : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
        To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
        Body: body,
      }),
    });
    if (!response.ok) throw new Error(`Twilio refused the message (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
}
