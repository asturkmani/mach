import type { ModelMessage } from "ai";

import type { BrowserJob } from "@/lib/agents/browser-agent";
import type { AgentContext } from "@/lib/agents/prompts";
import {
  createBrowserSession,
  getBrowserSession,
  saveBrowserSession,
  type BrowserSession,
  type BrowserSessionStatus,
} from "@/lib/browser-sessions";
import { saveVersion } from "@/lib/files";
import { openCompanySandbox, sandboxNameOf } from "@/lib/sandbox";

// The browser agent's database and file work, each a durable step (it also
// runs inside task agent workflows).

/** A screenshot the browser agent kept: saved with the task's files (or the company's), and small enough to show the caller. */
export type Evidence = { name: string; caption: string; versionId: string | null; image: string | null };

const EVIDENCE_DIR = "/vercel/job/outputs/browser";

export async function openBrowserSession(
  context: AgentContext,
  job: BrowserJob,
): Promise<{ session: BrowserSession } | { error: string }> {
  "use step";
  if (job.session) {
    const session = await getBrowserSession(context.organizationId, job.session, { taskId: context.taskId, personId: context.personId });
    if (!session) return { error: `There's no browser session ${job.session} here. Start a new one with task.` };
    return { session };
  }
  if (!job.task?.trim()) return { error: "Say what to do (task), or continue a session (session and message)." };
  return {
    session: await createBrowserSession(context.organizationId, {
      taskId: context.taskId,
      personId: context.personId,
      goal: job.task.trim(),
      approval: job.changes && job.approval ? String(job.approval) : null,
    }),
  };
}

export async function closeBrowserSession(
  context: AgentContext,
  id: string,
  patch: { messages: ModelMessage[]; status: BrowserSessionStatus; login: string | null },
): Promise<void> {
  "use step";
  await saveBrowserSession(id, patch);
}

/** Saves the screenshots the browser agent kept as files, and returns them scaled down for the caller to see. */
export async function keepEvidence(context: AgentContext, kept: { name: string; caption: string }[]): Promise<Evidence[]> {
  "use step";
  const sandbox = await openCompanySandbox(context.organizationId, sandboxNameOf(context), async () => {});
  const { default: sharp } = await import("sharp");
  const out: Evidence[] = [];
  for (const { name, caption } of kept) {
    const bytes = await sandbox.readFile(`${EVIDENCE_DIR}/${name}.png`);
    if (!bytes) continue;
    let versionId: string | null = null;
    try {
      const saved = await saveVersion(context.organizationId, {
        name: `screenshot-${name}.png`,
        kind: "deliverable",
        bytes,
        contentType: "image/png",
        taskId: context.taskId ?? undefined,
        agentId: context.agentId ?? undefined,
        personId: context.taskId ? undefined : context.personId,
        note: caption,
      });
      versionId = saved.versionId;
    } catch (error) {
      console.error("Couldn't keep a browser screenshot", error);
    }
    const image = await sharp(bytes)
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer()
      .then((b) => b.toString("base64"))
      .catch(() => null);
    out.push({ name, caption, versionId, image });
  }
  return out;
}
