import type { Agent } from "@/lib/agents/store";
import { skillList } from "@/lib/agents/skills";
import type { Organization } from "@/lib/orgs";
import type { Task, TaskMessage, TaskOutput } from "@/lib/tasks";

// What an agent reads when it works a task: its instructions, the company
// profile and everything on the task. Plain functions, so they can run in a
// workflow, a step or a test alike.

/** Agent runs allowed in a row before a person has to step in again. */
export const MAX_AGENT_TURNS = 6;

/** People read the summary as one line in their inbox. */
export const SUMMARY_MAX = 140;

export type RunOutcome =
  | { type: "asked" }
  | { type: "finished" }
  | { type: "handed_off"; agentId: string }
  | { type: "busy" }
  | { type: "skipped"; reason: string }
  | { type: "failed"; error: string };

/** What every step of a run needs to know. Plain values, so it can be passed between workflow steps. */
export type RunContext = { organizationId: string; taskId: string; agentId: string; agentName: string };

/** Exactly one option is recommended: the one the agent marked, else the first. */
export function normalizeOptions(options: { label: string; recommended?: boolean }[] = []) {
  const chosen = Math.max(
    0,
    options.findIndex((o) => o.recommended),
  );
  return options.map((o, i) => ({ label: o.label.trim(), recommended: i === chosen }));
}

export function lastLines(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-max).join("\n");
}

const time = (date: Date) => new Date(date).toISOString().slice(0, 16).replace("T", " ");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…cut, ${text.length - max} more characters]` : text);

export function taskBrief({
  task,
  messages,
  outputs,
  agent,
}: {
  task: Task;
  messages: TaskMessage[];
  outputs: TaskOutput[];
  agent: Agent;
}): string {
  const members = task.members
    .map((m) =>
      m.type === "person"
        ? `- ${m.name} (person${m.role ? `, ${m.role}` : ""})`
        : `- ${m.name} (${m.kind} agent${m.role ? `, ${m.role}` : ""})${m.id === agent.id ? " ← you" : ""}`,
    )
    .join("\n");
  // Long threads keep the opening message and the most recent ones.
  const shown = messages.length > 60 ? [messages[0], ...messages.slice(-59)] : messages;
  const thread = shown
    .map((m) => `[${time(m.createdAt)}] ${m.author} (${m.kind}):\n${clip(m.body, 6000)}`)
    .join("\n\n");
  const files = outputs.map((o) => `<file name="${o.filename}">\n${clip(o.content, 8000)}\n</file>`).join("\n");

  return `<task number="${task.number}">
Title: ${task.title}
Status: ${task.status} · Priority: ${task.priority}
Created: ${time(task.createdAt)}

Description:
${task.description || "(none)"}

Summary line: ${task.summary || "(none yet)"}
Context: ${task.context || "(none yet)"}
Done so far:
${task.progress || "(nothing yet)"}

On this task:
${members}

Thread (oldest first):
${thread || "(empty)"}
${files ? `\nFiles saved on this task:\n${files}` : ""}
</task>`;
}

export function agentInstructions({
  organization,
  agent,
  profile,
  brief,
}: {
  organization: Organization;
  agent: Agent;
  profile: string;
  brief: string;
}): string {
  const who =
    agent.kind === "worker"
      ? `You are ${agent.name}, a general worker agent at ${organization.name}${agent.role ? ` (${agent.role})` : ""}. You were made for this one task: do it well and nothing else.`
      : `You are ${agent.name}, an agent at ${organization.name}${agent.role ? `. Your role: ${agent.role}` : ""}.`;
  const today = new Date().toISOString().slice(0, 10);
  return `${who}
${agent.description ? `\nYour job:\n${agent.description}\n` : ""}${agent.instructions ? `\nYour instructions:\n${agent.instructions}\n` : ""}
You work on tasks in Mach, where people and agents run the company together. Everyone on a task sees its thread. Your task is below; read all of it, including what other agents have already done, before you act.

How to work:
- Do the work yourself with your tools. Look things up instead of asking. Load a skill when the work matches one.
- Save deliverables (models, tables, drafts, lists) as files with save_output: CSV for tables and models, markdown for documents.
- Use post_update for a short note on the thread when you reach a milestone on long work. Don't narrate every step.
- Never give a number you didn't find or calculate. Say what you don't know.

How to end your run (call exactly one of these):
- finish: the work is done, or done as far as you can take it. Report the result.
- ask: you need a decision only a person can make (taste, money, anything outward-facing or hard to undo). Decide everything else yourself and say what you decided. Ask everything you need in one go, and never ask again what the thread already answers.
- hand_off: another agent on this task should take the next step. Say exactly what they should do.

How to write it. People see your task as one row among many in their inbox and usually decide from that row:
- summary: one sentence that says what happened and what you need from them, e.g. "Q4 model is done: revenue up 18% to $11.2B. Share it with Lina?". Not background and not the title again.
- report or question: lead with the result or the decision needed, in plain sentences. Keep a report on your own work under 250 words; when the task asked for a write-up, the write-up is the deliverable and can be as long as it needs, with headings and tables.
- options: when anything is left for them to decide, give one to three next moves, each something you would start on straight away, with exactly one recommended. They are the answers to your summary's question. When nothing is left to decide, give none.
- context and progress: keep them current so anyone can pick the task up from the summary alone.

Skills you can load with use_skill:
${skillList()}

Today's date: ${today}.

<company_profile>
${profile}
</company_profile>

${brief}`;
}

export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/[#*`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = line.match(/^.+?[.!?](\s|$)/)?.[0].trim() ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}
