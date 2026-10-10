import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// WhatsApp through Twilio: one Mach1-wide WhatsApp sender. Twilio posts each
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

/** Sends one file on WhatsApp, from a link Twilio fetches (lib/file-links.ts), with an optional caption. */
export async function sendWhatsAppFile(to: string, mediaUrl: string, caption = ""): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const from = process.env.TWILIO_WHATSAPP_FROM!;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
      To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
      MediaUrl: mediaUrl,
      ...(caption ? { Body: whatsappText(caption).slice(0, 1000) } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Twilio refused the file (${response.status}): ${(await response.text()).slice(0, 300)}`);
}

/**
 * Marks their message read (blue ticks) and shows "typing…" in their chat:
 * Twilio's typing indicator (public beta), which WhatsApp shows until the
 * reply arrives or for 25 seconds. Never throws: it's a courtesy.
 */
export async function showTyping(messageSid: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  try {
    const response = await fetch("https://messaging.twilio.com/v2/Indicators/Typing.json", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ messageId: messageSid, channel: "whatsapp" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.error(`Twilio typing indicator failed (${response.status})`);
  } catch (error) {
    console.error("Twilio typing indicator failed", (error as Error).message);
  }
}

/** Keeps "typing…" showing while a reply is being worked on (WhatsApp drops it after 25 seconds). Returns how to stop. */
export function keepTyping(messageSid: string | undefined): () => void {
  if (!messageSid) return () => {};
  void showTyping(messageSid);
  const timer = setInterval(() => void showTyping(messageSid), 20_000);
  return () => clearInterval(timer);
}

/** The approved WhatsApp template for writing to someone outside the 24-hour window, if one is set up (docs/channels.md). */
export const whatsappTemplateSid = () => (twilioConfigured() && process.env.TWILIO_WHATSAPP_TEMPLATE_SID) || null;

/** A template's variable: one sentence-ending line, at most `max` characters (WhatsApp refuses line breaks and long values). */
export function templateValue(text: string, max = 900): string {
  const line = whatsappText(text).replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
  const cut = line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  // The template carries on after it ("… Reply to carry on."), so it ends a sentence.
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * Sends an approved template (Twilio Content) with its variables, e.g.
 * { "1": "Sara", "2": "#14 is ready…" }: the only way to write first once the
 * 24 hours since their last message have passed.
 */
export async function sendWhatsAppTemplate(to: string, contentSid: string, variables: Record<string, string>): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const from = process.env.TWILIO_WHATSAPP_FROM!;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
      To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(variables),
    }),
  });
  if (!response.ok) throw new Error(`Twilio refused the template (${response.status}): ${(await response.text()).slice(0, 300)}`);
}

/**
 * Downloads media someone sent (a voice note): Twilio's media URLs need the
 * account's credentials, so only its own API host is fetched with them.
 */
export async function fetchTwilioMedia(url: string, maxBytes: number): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.twilio.com") throw new Error(`Not a Twilio media URL: ${parsed.hostname}`);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  // Twilio redirects to its CDN; fetch drops the credentials on the way there.
  const response = await fetch(parsed, { headers: { Authorization: `Basic ${auth}` } });
  if (!response.ok) throw new Error(`Twilio wouldn't give the media (${response.status})`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("The media is too big");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("The media is too big");
  return bytes;
}
