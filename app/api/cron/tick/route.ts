import { after } from "next/server";

import { runAssistantWakeups } from "@/lib/assistant/wake";
import { fireDueSchedules } from "@/lib/work";

// Called by Vercel Cron every minute (vercel.json) to start recurring jobs
// that are due, and to wake people's assistants (lib/assistant/wake.ts),
// which runs on after the response. Vercel sends CRON_SECRET as a bearer
// token; nothing else may call it.
export const maxDuration = 800;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = await fireDueSchedules();
  after(() => runAssistantWakeups().catch((error) => console.error("Assistant wake-ups failed", error)));
  return Response.json({ started });
}
