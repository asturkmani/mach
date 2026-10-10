import { WorkflowAgent } from "@ai-sdk/workflow";

import { startFollowersStep } from "@/lib/agents/follower-steps";
import { CompanyModel } from "@/lib/ai/company-model";
import { hasToolCall, isStepCount, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

import { SUMMARY_MAX, type RunContext, type RunOutcome } from "@/lib/agents/prompts";
import {
  agentForLatestMessage,
  askPeople,
  beginRun,
  endRun,
  finishWork,
  handOff,
  keepLease,
  personCommentCount,
  postUpdate,
  recordFailure,
  reportText,
  saveFile,
  scheduleJob,
  unscheduleJob,
  type BriefImage,
} from "@/lib/agents/run-steps";
import { askForLoginCode } from "@/lib/agents/browser-steps";
import { attachSandboxFile, closeSandbox } from "@/lib/agents/sandbox-steps";
import { exaTools, investigateTool } from "@/lib/research/tools";
import { SKILL_TOOLS, toolsOf } from "@/lib/agents/skills";
import { trimToolResults } from "@/lib/agents/trim";
import {
  browserTools,
  githubTools,
  integrationTools,
  researchTools,
  sandboxTools,
  sandboxUser,
  skillTool,
  type SandboxSession,
  type SandboxUser,
} from "@/lib/agents/toolkit";

// Runs agents on a task. The agent sees everything on the task (its
// description, summary, the people and agents on it, the whole thread and any
// files) plus the company profile, works with its tools, and ends by asking
// the people on the task something, reporting back, or handing the task to
// another agent on it.
//
// This code runs inside the agent-run workflow (workflows/agent-run.ts), so it
// only orchestrates: every model call is a durable step (WorkflowAgent), and
// every database change goes through a step in run-steps.ts. A run can
// therefore take far longer than one function invocation is allowed to.

export { MAX_AGENT_TURNS, normalizeOptions, taskBrief, type RunOutcome } from "@/lib/agents/prompts";

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

type RunState = SandboxSession & { outcome?: RunOutcome; loaded?: Set<string> };

/** The tools of an agent on a task: delivering files, reporting, asking, handing off and scheduling. */
function taskTools(
  context: RunContext,
  otherAgents: { id: string; name: string }[],
  using: SandboxUser,
  end: (outcome: RunOutcome) => void,
) {
  return {
    attach_file: tool({
      description:
        "Attach a file from the sandbox (usually in outputs/) to the task as a deliverable people can open. A file with the same name as one already on the task becomes its next version.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to /vercel/job, e.g. outputs/portfolio-model.xlsx, or on /vercel/drive."),
        note: z.string().optional().describe("What this version is, e.g. 'rules ABD' or '70/30 mix'."),
      }),
      execute: (input) => using(() => attachSandboxFile(context, input)),
    }),
    post_update: tool({
      description: "Post a short progress note on the task's thread. Doesn't end your run.",
      inputSchema: z.object({ message: z.string().min(1), progress: reportFields.progress }),
      execute: (input) => postUpdate(context, input),
    }),
    save_output: tool({
      description:
        "Save a short text file on the task (a list, a draft, a small table) without using the sandbox. Saving the same filename again makes a new version.",
      inputSchema: z.object({
        filename: z
          .string()
          .regex(/^[\w][\w .()-]{0,79}\.(csv|md|txt|json)$/i, "Use a simple name ending in .csv, .md, .txt or .json."),
        content: z.string().min(1).max(200_000),
      }),
      execute: (input) => saveFile(context, input),
    }),
    set_schedule: tool({
      description:
        "Make this job repeat on a schedule, or change its schedule. Each run lands on this task and works in this job's sandbox.",
      inputSchema: z.object({
        cron: z.string().describe("Five-field cron in the timezone below, e.g. '0 16 * * 1-5' for weekdays at 16:00, '0 9 * * 1' for Mondays at 09:00."),
        timezone: z.string().describe("IANA timezone, e.g. Europe/London: the one people asked for, else the company's."),
        mode: z
          .enum(["script", "agent"])
          .describe("script: each run replays run.sh without you, and you're woken only if it fails. agent: you do the job each run."),
      }),
      execute: (input) => scheduleJob(context, input),
    }),
    stop_schedule: tool({
      description: "Stop this job from repeating.",
      inputSchema: z.object({}),
      execute: () => unscheduleJob(context),
    }),
    ask: tool({
      description: "End your run with a question for the people on the task. They answer in the thread.",
      inputSchema: z.object({
        ...reportFields,
        question: z.string().min(1).describe("The question, with just enough context to answer it from this message alone."),
      }),
      execute: async (input) => {
        const result = await askPeople(context, input);
        end({ type: "asked" });
        return result;
      },
    }),
    finish: tool({
      description: "End your run by reporting the result to the people on the task.",
      inputSchema: z.object({
        ...reportFields,
        report: z.string().min(1).describe("The result in plain sentences, or the full write-up when one was asked for."),
      }),
      execute: async (input) => {
        const result = await finishWork(context, input);
        end({ type: "finished" });
        return result;
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
            execute: async ({ to, ...input }) => {
              const next = otherAgents.find((a) => a.name === to)!;
              const result = await handOff(context, { ...input, to: next });
              end({ type: "handed_off", agentId: next.id });
              return result;
            },
          }),
        }
      : {}),
  } satisfies ToolSet;
}

const fileName = (path: unknown) => String(path ?? "").split("/").filter(Boolean).pop() ?? "a file";
const clipped = (text: unknown, max = 48) => {
  const line = String(text ?? "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What the agent is doing while a tool runs, in a few words for the live status on the task. */
export function activityFor(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "run_code":
      return `Running ${fileName(input.filename)}`;
    case "run_command":
      return `Running ${clipped(input.command)}`;
    case "read_file":
      return `Reading ${fileName(input.path)}`;
    case "write_file":
      return `Writing ${fileName(input.path)}`;
    case "list_files":
      return input.folder === "drive" ? "Looking through the drive" : "Looking through the job's files";
    case "attach_file":
      return `Attaching ${fileName(input.path)}`;
    case "save_output":
      return `Saving ${fileName(input.filename)}`;
    case "call_api":
      return `Calling ${input.integration}`;
    case "read_integration_guide":
      return `Reading the ${input.integration} guide`;
    case "save_integration_guide":
      return `Updating the ${input.integration} guide`;
    case "browser_login":
      return `Signing in to ${input.login}`;
    case "use_browser":
      return `Using the browser: ${clipped(input.task ?? input.message, 40)}`;
    case "post_update":
      return "Posting an update";
    case "set_schedule":
      return "Setting the schedule";
    case "stop_schedule":
      return "Stopping the schedule";
    case "use_skill":
      return `Reading the ${input.name} playbook`;
    case "market_data":
      return `Looking up ${[input.symbols].flat().filter(Boolean).join(", ") || clipped(input.query, 30) || "market data"} (${input.action})`;
    case "x_search":
      return `Searching X: ${clipped(input.query, 40) || "the latest posts"}`;
    case "reddit_search":
      return `Searching Reddit: ${clipped(input.query, 40)}`;
    case "investigate":
      return `Investigating: ${clipped(input.question, 48)}`;
    case "ask":
      return "Writing a question";
    case "finish":
      return "Writing the report";
    case "hand_off":
      return "Handing off";
    default:
      return tool.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

/** Thrown before a model call when a person pressed Send now; the run ends as interrupted. */
class Interrupted extends Error {
  constructor() {
    super("Interrupted by a new message.");
  }
}

/**
 * Tools that first say what the agent is doing, so the task shows it live. A
 * person's Send now stops the run before the next tool does anything.
 */
function narrated(context: RunContext, tools: ToolSet, interrupt: () => void): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute;
      if (!execute) return [name, t]; // run by the provider (web search), with no step of ours to mark
      return [
        name,
        {
          ...t,
          execute: async (input: Record<string, unknown>, options: Parameters<typeof execute>[1]) => {
            if (await keepLease(context, activityFor(name, input ?? {}))) {
              interrupt();
              return "Not done: a person sent a new message and asked you to stop. Your run ends here and starts again with their message.";
            }
            return execute(input, options);
          },
        },
      ];
    }),
  ) as ToolSet;
}

/** The run's opening message, with the images people just attached. */
function withImages(prompt: string, images: BriefImage[]): string | ModelMessage[] {
  if (images.length === 0) return prompt;
  const named = images.map((i) => i.name).join(", ");
  return [
    {
      role: "user",
      content: [
        { type: "text", text: `${prompt}\n\nThe images attached in the thread since you last wrote (${named}) are below.` },
        ...images.map((i) => ({ type: "image" as const, image: i.data, mediaType: i.mediaType })),
      ],
    },
  ];
}

/** One agent's turn on a task. */
export async function runAgentOnTask(
  organizationId: string,
  taskId: string,
  agentId: string,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const begun = await beginRun(organizationId, taskId, agentId);
  if (!begun.ok) return begun.outcome;
  const { context } = begun;
  const state: RunState = {};
  const using = sandboxUser(context, state);
  const end = (ended: RunOutcome) => (state.outcome = ended);
  const interrupt = () => end({ type: "interrupted" });
  let outcome: RunOutcome | undefined;

  try {
    // The company's own provider keys ride along with each model call (bring your own key).
    const model = options.model ?? new CompanyModel(organizationId, begun.model);
    const research = options.research === false ? {} : { ...researchTools(context), ...exaTools() };
    // Skills loaded during the run switch on their tools from the next step (pinned ones from the start).
    state.loaded = new Set(begun.skills);
    const tools = narrated(context, {
        ...taskTools(context, begun.otherAgents, using, end),
        ...sandboxTools(context, using),
        ...integrationTools(context, using, { sources: begun.sources, logins: begun.logins }),
        ...browserTools(context, using, begun.logins, async (login) => {
          // The people on the task are asked for the code; their reply finishes the sign-in on the next run.
          const asked = await askForLoginCode(context, login);
          end({ type: "asked" });
          return { text: asked, needsCode: login };
        }, { durable: true, heartbeat: () => keepLease(context, "Using the browser") }),
        ...githubTools(context),
        ...research,
        // Research sends questions to sub-researchers, on the same model, each with the research tools.
        investigate: investigateTool(context, {
          model,
          research,
          highSignal: begun.highSignal,
          durable: true,
          heartbeat: () => keepLease(context, "Investigating"),
        }),
        use_skill: skillTool(undefined, (name) => state.loaded?.add(name)),
      }, interrupt);
    // Tools a skill switches on stay off until one of its skills is pinned or loaded.
    const activeTools = () => {
      const on = new Set(toolsOf([...(state.loaded ?? [])]));
      return Object.keys(tools).filter((name) => !SKILL_TOOLS.has(name) || on.has(name));
    };
    const agent = new WorkflowAgent({
      model,
      instructions: begun.instructions,
      // No activeTools here: it would fix the set for the whole run. prepareStep picks them before every step.
      tools,
      // A run also ends when a tool ended it (e.g. a sign-in that asked for a code).
      stopWhen: [isStepCount(40), hasToolCall("ask", "finish", "hand_off"), () => state.outcome !== undefined],
      // Long runs keep their lease fresh before each model call (and say they're thinking), and stop
      // there if a person pressed Send now.
      prepareStep: async ({ messages }) => {
        if (await keepLease(context, "Thinking")) {
          interrupt();
          throw new Interrupted();
        }
        const trimmed = trimToolResults(messages);
        return { activeTools: activeTools(), ...(trimmed === messages ? {} : { messages: trimmed }) };
      },
    });
    const result = await agent.generate({ prompt: withImages(begun.prompt, begun.images) });
    outcome = state.outcome ?? (await reportText(context, result.text));
    return outcome;
  } catch (error) {
    if (state.outcome?.type === "interrupted") {
      outcome = state.outcome;
      return outcome;
    }
    outcome = await recordFailure(context, error instanceof Error ? error.message : String(error));
    return outcome;
  } finally {
    if (state.used) {
      try {
        await closeSandbox(context);
      } catch (error) {
        console.error(`Couldn't close the sandbox for task ${context.taskId}`, error);
      }
    }
    await endRun(context, begun.answering, outcome);
  }
}

/**
 * Runs an agent, then whoever it hands off to. If a person replied while an
 * agent was working (a queued message), that agent didn't see it, so it goes
 * again. If they pressed Send now, the run stopped early and the agent their
 * message is for starts straight away.
 */
export async function runAgentChain(
  organizationId: string,
  taskId: string,
  agentId: string,
  options: RunOptions = {},
): Promise<void> {
  let next: string | undefined = agentId;
  while (next) {
    const current: string = next;
    const commentsBefore = await personCommentCount(taskId);
    const outcome = await runAgentOnTask(organizationId, taskId, current, options);
    if (outcome.type === "handed_off") {
      next = outcome.agentId;
    } else if (outcome.type === "interrupted") {
      next = await agentForLatestMessage(organizationId, taskId);
    } else if ((outcome.type === "asked" || outcome.type === "finished") && (await personCommentCount(taskId)) > commentsBefore) {
      next = current;
    } else {
      next = undefined;
    }
  }
  await startFollowersStep(organizationId, taskId);
}
