import "server-only";

import { gateway, hasToolCall, isStepCount, ToolLoopAgent, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";

import { getAgent, type Agent } from "@/lib/agents/store";
import { skillList, skillTool } from "@/lib/agents/skills";
import { getOrganization, type Organization } from "@/lib/orgs";
import { loadProfile } from "@/lib/profile/store";
import {
  addMessage,
  agentsOn,
  claimRun,
  getTask,
  listMessages,
  listOutputs,
  releaseRun,
  saveOutput,
  updateTask,
  type Task,
  type TaskMessage,
  type TaskOutput,
} from "@/lib/tasks";

// Runs one agent on one task. The agent sees everything on the task (its
// description, summary, the people and agents on it, the whole thread and any
// files) plus the company profile, works with its tools, and ends by asking
// the people on the task something, reporting back, or handing the task to
// another agent on it.

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

export type RunOptions = { model?: LanguageModel; research?: boolean };

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("A next move in a few words, e.g. 'Share it with Lina'."),
  recommended: z.boolean().optional(),
});

const reportFields = {
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX)
    .describe(
      `One sentence, under ${SUMMARY_MAX} characters, saying what happened and what you need from them. This is the line they read in their inbox.`,
    ),
  options: z
    .array(optionSchema)
    .max(3)
    .optional()
    .describe("One to three next moves for them to pick from, exactly one recommended. Leave out if nothing is left to decide."),
  context: z
    .string()
    .max(400)
    .optional()
    .describe("Up to 45 words that bring this task back to someone who has forgotten it: what was asked, what was found."),
  progress: z
    .string()
    .max(600)
    .optional()
    .describe("The steps done so far, one per line, oldest first, at most six lines. Send the whole list."),
};

/** Exactly one option is recommended: the one the agent marked, else the first. */
export function normalizeOptions(options: { label: string; recommended?: boolean }[] = []) {
  const chosen = Math.max(
    0,
    options.findIndex((o) => o.recommended),
  );
  return options.map((o, i) => ({ label: o.label.trim(), recommended: i === chosen }));
}

function lastLines(text: string | undefined, max: number): string | undefined {
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

function agentModel(): string {
  const model = process.env.AGENT_MODEL || process.env.CHIEF_OF_STAFF_MODEL;
  if (!model) throw new Error("Set AGENT_MODEL or CHIEF_OF_STAFF_MODEL to an AI Gateway model id (see README).");
  return model;
}

export async function runAgentOnTask(
  organizationId: string,
  taskId: string,
  agentId: string,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const [organization, task, agent] = await Promise.all([
    getOrganization(organizationId),
    getTask(organizationId, taskId),
    getAgent(organizationId, agentId),
  ]);
  if (!organization || !task || !agent) return { type: "skipped", reason: "Task or agent not found." };
  if (!agentsOn(task).some((m) => m.id === agent.id)) return { type: "skipped", reason: `${agent.name} isn't on this task.` };
  if (agent.status !== "active") return { type: "skipped", reason: `${agent.name} is ${agent.status}.` };
  if (task.status === "done" || task.status === "cancelled") return { type: "skipped", reason: "The task is closed." };

  if (task.agentTurns >= MAX_AGENT_TURNS) {
    await updateTask(organizationId, task.id, {
      status: "waiting",
      summary: `Agents have taken ${task.agentTurns} turns in a row without a person. Check the thread and say how to go on.`,
      options: [],
    });
    return { type: "skipped", reason: "Too many agent turns in a row." };
  }

  if (!(await claimRun(organizationId, task.id, agent.id))) return { type: "busy" };

  let outcome: RunOutcome | undefined;
  const author = { author: agent.name, agentId: agent.id };

  try {
    const [profile, messages, outputs] = await Promise.all([
      loadProfile(organizationId),
      listMessages(task.id),
      listOutputs(task.id),
    ]);
    const brief = taskBrief({ task, messages, outputs, agent });
    const otherAgents = agentsOn(task).filter((m) => m.id !== agent.id);

    const outcomeTools = {
      post_update: tool({
        description: "Post a short progress note on the task's thread. Doesn't end your run.",
        inputSchema: z.object({ message: z.string().min(1), progress: reportFields.progress }),
        execute: async ({ message, progress }) => {
          await addMessage(task.id, { ...author, kind: "update", body: message });
          if (progress !== undefined) await updateTask(organizationId, task.id, { progress: lastLines(progress, 6) });
          return "Posted.";
        },
      }),
      save_output: tool({
        description:
          "Save a file on the task, e.g. a model as CSV or a report as markdown. Saving the same filename again replaces it.",
        inputSchema: z.object({
          filename: z
            .string()
            .regex(/^[\w][\w .()-]{0,79}\.(csv|md|txt|json)$/i, "Use a simple name ending in .csv, .md, .txt or .json."),
          content: z.string().min(1).max(200_000),
        }),
        execute: async ({ filename, content }) => {
          await saveOutput(task.id, { filename, content, agentId: agent.id });
          return `Saved ${filename}.`;
        },
      }),
      ask: tool({
        description: "End your run with a question for the people on the task. They answer in the thread.",
        inputSchema: z.object({
          ...reportFields,
          question: z.string().min(1).describe("The question, with just enough context to answer it from this message alone."),
        }),
        execute: async ({ summary, question, options: picks, context, progress }) => {
          await addMessage(task.id, { ...author, kind: "ask", body: question });
          await updateTask(organizationId, task.id, {
            status: "waiting",
            summary,
            options: normalizeOptions(picks),
            context,
            progress: lastLines(progress, 6),
          });
          outcome = { type: "asked" };
          return "Asked. Your run ends here; their answer starts your next one.";
        },
      }),
      finish: tool({
        description: "End your run by reporting the result to the people on the task.",
        inputSchema: z.object({
          ...reportFields,
          report: z.string().min(1).describe("The result in plain sentences, or the full write-up when one was asked for."),
        }),
        execute: async ({ summary, report, options: picks, context, progress }) => {
          await addMessage(task.id, { ...author, kind: "result", body: report });
          await updateTask(organizationId, task.id, {
            status: "review",
            summary,
            options: normalizeOptions(picks),
            context,
            progress: lastLines(progress, 6),
          });
          outcome = { type: "finished" };
          return "Reported. Your run ends here.";
        },
      }),
      ...(otherAgents.length > 0
        ? {
            hand_off: tool({
              description: "End your run and pass the next step to another agent on this task.",
              inputSchema: z.object({
                to: z.enum(otherAgents.map((a) => a.name) as [string, ...string[]]),
                note: z.string().min(1).describe("What you did and exactly what they should do next."),
                summary: reportFields.summary,
                progress: reportFields.progress,
              }),
              execute: async ({ to, note, summary, progress }) => {
                const next = otherAgents.find((a) => a.name === to)!;
                await addMessage(task.id, { ...author, kind: "update", body: `@${next.name} ${note}` });
                await updateTask(organizationId, task.id, { summary, progress: lastLines(progress, 6) });
                outcome = { type: "handed_off", agentId: next.id };
                return `Handed to ${next.name}.`;
              },
            }),
          }
        : {}),
    } satisfies ToolSet;

    const research: ToolSet =
      options.research === false
        ? {}
        : {
            web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
            fetch_page: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true, proxies: false }),
          };

    const runner = new ToolLoopAgent({
      model: options.model ?? agentModel(),
      instructions: agentInstructions({ organization, agent, profile, brief }),
      tools: { ...outcomeTools, ...research, use_skill: skillTool() },
      stopWhen: [isStepCount(40), hasToolCall("ask", "finish", "hand_off")],
    });

    const result = await runner.generate({
      prompt: `Work on task #${task.number} now. End with finish, ask${otherAgents.length ? " or hand_off" : ""}.`,
    });

    if (!outcome) {
      // The model stopped without calling an outcome tool: report whatever it said.
      const text = result.text.trim();
      await addMessage(task.id, { ...author, kind: "result", body: text || "I stopped without a result." });
      await updateTask(organizationId, task.id, {
        status: text ? "review" : "waiting",
        summary: text ? firstSentence(text) : `${agent.name} stopped without reporting back. Try again?`,
        options: text ? [] : [{ label: "Try again", recommended: true }],
      });
      outcome = text ? { type: "finished" } : { type: "failed", error: "No result." };
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await addMessage(task.id, { author: agent.name, agentId: agent.id, kind: "event", body: `Run failed: ${message}` });
    await updateTask(organizationId, task.id, {
      status: "waiting",
      summary: `${agent.name} couldn't finish: ${firstSentence(message, 90)}`,
      options: [{ label: "Try again", recommended: true }],
    });
    return { type: "failed", error: message };
  } finally {
    await releaseRun(task.id, agent.id);
  }
}

export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/[#*_`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = line.match(/^.+?[.!?](\s|$)/)?.[0].trim() ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}
