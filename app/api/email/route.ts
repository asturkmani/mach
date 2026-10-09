import { after } from "next/server";

import { agentmailConfigured, validSvixSignature, webhookSecrets } from "@/lib/channels/agentmail";
import { handleEmail, type ReceivedEmail } from "@/lib/channels/inbound";
import { firstTime } from "@/lib/channels/senders";

// AgentMail posts each email to a company's Chief of Staff inbox here, signed
// with Svix. The reply goes back in the thread after this request returns.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!agentmailConfigured()) return new Response("Email isn't set up.", { status: 404 });
  const body = await request.text();
  const headers = {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  };
  if (!validSvixSignature(headers, body, await webhookSecrets())) return new Response("Bad signature.", { status: 400 });
  const event = JSON.parse(body) as { event_type?: string; event_id?: string; message?: ReceivedEmail };
  // Only mail that passed the sender's authentication (SPF/DKIM): AgentMail labels the rest
  // message.received.unauthenticated, .spam or .blocked.
  if (event.event_type !== "message.received" || !event.message) return new Response(null, { status: 204 });
  if (!(await firstTime("agentmail", event.event_id ?? headers.id!))) return new Response(null, { status: 204 });
  const email = event.message;
  after(() => handleEmail(email).catch((error) => console.error("Email reply failed", error)));
  return new Response(null, { status: 204 });
}
