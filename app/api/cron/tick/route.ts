import { fireDueSchedules } from "@/lib/work";

// Called by Vercel Cron every minute (vercel.json) to start recurring jobs
// that are due. Vercel sends CRON_SECRET as a bearer token; nothing else may
// call it.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = await fireDueSchedules();
  return Response.json({ started });
}
