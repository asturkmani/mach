import { listTaskFiles } from "@/lib/files";
import { listRunLogs, type RunLog } from "@/lib/learning/run-log";
import { listChildren, listMessages, type Task, type TaskMessage } from "@/lib/tasks";

// The run record a review reads: a selection of what Mach1 already stores, not
// a summary, so nothing a person said is lost. The request and the skills it
// had, the steps from the run log (tools called, scripts run with their exit
// codes), what people wrote, how it ended and what it delivered. It leaves out
// raw pages and API responses: long, and the untrusted part. Every step and
// message has an id (S3, M2) that a proposed change must cite.

/** Kept well under the decision model's limit: about 24k tokens. */
const MAX_CHARS = 90_000;

export type RunRecord = {
  text: string;
  /** The ids a change may cite: steps and messages in this record. */
  ids: Set<string>;
  /** Scripts written or run, by path, with whether their last run worked. */
  scripts: Map<string, boolean>;
  /** Skills the work had: pinned, or loaded during it. */
  skills: string[];
  runs: number;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Person messages and agents' questions and results, since the review before. */
const spoken = (messages: TaskMessage[], since: Date | null) =>
  messages.filter((m) => (!since || m.createdAt > since) && (m.personId ? m.kind === "comment" : m.kind === "ask" || m.kind === "result"));

export async function buildRunRecord(organizationId: string, task: Task, since: Date | null): Promise<RunRecord> {
  const children = await listChildren(organizationId, task.id);
  const [runs, messages, files] = await Promise.all([
    listRunLogs([task.id, ...children.map((c) => c.id)], since),
    listMessages(task.id),
    listTaskFiles(organizationId, task.id),
  ]);
  const ids = new Set<string>();
  const scripts = new Map<string, boolean>();
  let step = 0;
  let said = 0;

  const runLines = (run: RunLog, detail: boolean) => {
    const lines = [`Run by ${run.agentName}: ${run.outcome}, ${run.modelSteps} model steps${run.skillsLoaded.length ? `, loaded ${run.skillsLoaded.join(", ")}` : ""}.`];
    for (const s of run.steps) {
      const id = `S${++step}`;
      ids.add(id);
      if (/^(run_code|run_command|write_file|run\.sh)$/.test(s.tool)) {
        const path = s.detail.replace(/^(Running|Writing)\s+/, "");
        if (s.tool !== "run_command") scripts.set(path, s.exit === undefined ? s.ok : s.exit === 0);
      }
      if (detail) lines.push(`${id} ${s.tool}: ${s.detail}${s.exit !== undefined ? ` (exit ${s.exit})` : s.ok ? "" : " (refused or failed)"}`);
    }
    return lines;
  };

  const own = runs.filter((r) => r.taskId === task.id);
  const parts = [
    `<request number="${task.number}">\n${task.title}\n\n${clip(task.description, 3000)}\n</request>`,
    `Skills pinned: ${task.skills.join(", ") || "none"}.`,
    `<runs>\n${own.flatMap((r) => runLines(r, true)).join("\n") || "(none)"}\n</runs>`,
  ];
  if (children.length) {
    parts.push(
      `<children>\n${children
        .map((c) => {
          const theirs = runs.filter((r) => r.taskId === c.id);
          return [
            `#${c.number} ${c.title} (${c.assigneeKind}${c.skills.length ? `, skills ${c.skills.join(", ")}` : ""}): ${c.status}. ${c.summary}`,
            ...theirs.flatMap((r) => runLines(r, theirs.length <= 2)),
          ].join("\n");
        })
        .join("\n\n")}\n</children>`,
    );
  }
  const thread = spoken(messages, since).map((m) => {
    const id = `M${++said}`;
    ids.add(id);
    return `${id} ${m.author}${m.personId ? " (person)" : ""} [${m.kind}]: ${clip(m.body, 3000)}`;
  });
  parts.push(`<thread>\n${thread.join("\n\n") || "(nothing new)"}\n</thread>`);
  parts.push(`How it ended: ${task.status}. ${task.summary}`);
  const delivered = files.filter((f) => f.kind !== "code").map((f) => f.name);
  if (delivered.length) parts.push(`Deliverables: ${delivered.join(", ")}.`);
  if (task.memory) parts.push(`<notes>\n${clip(task.memory, 4000)}\n</notes>`);

  const skills = [...new Set([...task.skills, ...runs.flatMap((r) => [...r.skillsPinned, ...r.skillsLoaded])])];
  return { text: clip(parts.join("\n\n"), MAX_CHARS), ids, scripts, skills, runs: runs.length };
}
