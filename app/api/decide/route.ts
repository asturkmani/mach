import { z } from "zod";

import { decideForSkill, DecisionError, readRunToken } from "@/lib/decisions";

// mach.decide, from a job's scripts (docs/agent-design.md, Decisions inside
// skills). The sandbox's network proxy adds the run's token to every request
// to Mach1, so scripts hold no key; a request without one is refused.
export const maxDuration = 60;

const question = z.object({
  type: z.enum(["choice", "boolean"]).default("choice"),
  instructions: z.string().min(1).max(2000),
  options: z.union([z.array(z.string().min(1)).max(5000), z.record(z.string(), z.string().nullable())]).optional(),
});

const body = z.object({
  skill: z.string().min(1).max(80),
  state: z.string().min(1).max(60_000),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), question),
  key: z.string().max(300).optional(),
  target: z.number().min(0.5).max(1).optional(),
});

export async function POST(request: Request) {
  const run = readRunToken(request.headers.get("x-mach-run") ?? "");
  if (!run) return Response.json({ error: "Only a job's scripts can ask for decisions." }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    return Response.json({ answers: await decideForSkill(run.organizationId, run.taskId, parsed.data) });
  } catch (error) {
    if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
