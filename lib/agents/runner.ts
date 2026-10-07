import { WorkflowAgent } from "@ai-sdk/workflow";
import { gateway, hasToolCall, isStepCount, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";

import { SUMMARY_MAX, type RunContext, type RunOutcome } from "@/lib/agents/prompts";
import {
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
} from "@/lib/agents/run-steps";
import {
  attachSandboxFile,
  closeSandbox,
  listSandboxFiles,
  readSandboxFile,
  runCode,
  runShell,
  writeSandboxFile,
} from "@/lib/agents/sandbox-steps";
import { skillTool } from "@/lib/agents/skills";

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

type RunState = { outcome?: RunOutcome; usedSandbox?: boolean };

function sandboxTools(context: RunContext, state: RunState) {
  // Any sandbox tool starts (or resumes) the job's sandbox; it is closed when the run ends.
  const using = <T>(work: Promise<T>) => {
    state.usedSandbox = true;
    return work;
  };
  return {
    run_code: tool({
      description:
        "Save a script under code/ in the job's sandbox and run it from the job folder. Returns the exit code, stdout, stderr and the files it created or changed in outputs/.",
      inputSchema: z.object({
        filename: z.string().describe("A simple file name, e.g. simulate.py or build_model.py. Reusing a name replaces that script."),
        language: z.enum(["python", "node", "bash"]),
        code: z.string().min(1),
      }),
      execute: (input) => using(runCode(context, input)),
    }),
    run_command: tool({
      description: "Run a shell command in the job folder, e.g. to install a package or run run.sh.",
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: (input) => using(runShell(context, input)),
    }),
    read_file: tool({
      description: "Read a text file in the job folder (a path relative to /vercel/job).",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: (input) => using(readSandboxFile(context, input)),
    }),
    write_file: tool({
      description: "Write a text file in the job folder, e.g. config.yaml, run.sh or NOTES.md.",
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: (input) => using(writeSandboxFile(context, input)),
    }),
    list_files: tool({
      description: "List the files in the job folder.",
      inputSchema: z.object({}),
      execute: () => using(listSandboxFiles(context)),
    }),
    attach_file: tool({
      description:
        "Attach a file from the sandbox (usually in outputs/) to the task as a deliverable people can open. A file with the same name as one already on the task becomes its next version.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to /vercel/job, e.g. outputs/portfolio-model.xlsx."),
        note: z.string().optional().describe("What this version is, e.g. 'rules ABD' or '70/30 mix'."),
      }),
      execute: (input) => using(attachSandboxFile(context, input)),
    }),
  } satisfies ToolSet;
}

function runTools(context: RunContext, otherAgents: { id: string; name: string }[], end: (outcome: RunOutcome) => void) {
  return {
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

// Run by AI Gateway and billed to its credits.
const researchTools = (): ToolSet => ({
  web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
  fetch_page: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true, proxies: false }),
});

/** One agent's turn on a task. */
export async function runAgentOnTask(
  organizationId: string,
  taskId: string,
  agentId: string,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const begun = await beginRun(organizationId, taskId, agentId, { modelGiven: Boolean(options.model) });
  if (!begun.ok) return begun.outcome;
  const { context } = begun;
  const state: RunState = {};

  try {
    const agent = new WorkflowAgent({
      model: options.model ?? begun.model,
      instructions: begun.instructions,
      tools: {
        ...runTools(context, begun.otherAgents, (outcome) => (state.outcome = outcome)),
        ...sandboxTools(context, state),
        ...(options.research === false ? {} : researchTools()),
        use_skill: skillTool(),
      },
      stopWhen: [isStepCount(40), hasToolCall("ask", "finish", "hand_off")],
      // Long runs keep their lease fresh before each model call.
      prepareStep: async () => {
        await keepLease(context);
        return undefined;
      },
    });
    const result = await agent.generate({ prompt: begun.prompt });
    return state.outcome ?? (await reportText(context, result.text));
  } catch (error) {
    return recordFailure(context, error instanceof Error ? error.message : String(error));
  } finally {
    if (state.usedSandbox) {
      try {
        await closeSandbox(context);
      } catch (error) {
        console.error(`Couldn't close the sandbox for task ${context.taskId}`, error);
      }
    }
    await endRun(context);
  }
}

/**
 * Runs an agent, then whoever it hands off to. If a person replied while an
 * agent was working, that agent didn't see it, so it goes again.
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
    } else if ((outcome.type === "asked" || outcome.type === "finished") && (await personCommentCount(taskId)) > commentsBefore) {
      next = current;
    } else {
      next = undefined;
    }
  }
}
