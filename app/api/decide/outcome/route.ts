import { z } from "zod";

import { DecisionError, readRunToken, recordOutcome } from "@/lib/decisions";

// What happened to a decision mach.decide made: a person confirmed it or
// changed it. It joins the history the next decisions learn from, and the
// backtests that set when an answer is applied without asking.
const body = z.object({ id: z.string().uuid(), final: z.string().min(1).max(300), by: z.string().min(1).max(120) });

export async function POST(request: Request) {
  const run = readRunToken(request.headers.get("x-mach-run") ?? "");
  if (!run) return Response.json({ error: "Only a job's scripts can record outcomes." }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    return Response.json({ outcome: await recordOutcome(run.organizationId, parsed.data.id, parsed.data.final, parsed.data.by) });
  } catch (error) {
    if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
}
