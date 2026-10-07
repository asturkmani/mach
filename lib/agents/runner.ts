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
  scheduleJob,
  unscheduleJob,
} from "@/lib/agents/run-steps";
import {
  attachSandboxFile,
  closeSandbox,
  listSandboxFiles,
  readSandboxFile,
  runCode,
  runShell,
  startSandbox,
  writeSandboxFile,
} from "@/lib/agents/sandbox-steps";
import { askForLoginCode, browserLogin } from "@/lib/agents/browser-steps";
import { callApi, readIntegrationGuide, saveIntegrationGuide } from "@/lib/agents/integration-steps";
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

type RunState = { outcome?: RunOutcome; usedSandbox?: boolean; started?: Promise<string> };

/**
 * Wraps sandbox work: the first sandbox tool in a run starts (or resumes) the
 * job's sandbox, connects data sources and syncs the company drive into it;
 * it is closed when the run ends.
 */
function sandboxUser(context: RunContext, state: RunState) {
  return async <T>(work: () => Promise<T>) => {
    state.usedSandbox = true;
    state.started ??= startSandbox(context).catch((error) => {
      state.started = undefined; // the next sandbox tool tries again
      throw error;
    });
    await state.started;
    return work();
  };
}

function sandboxTools(context: RunContext, using: <T>(work: () => Promise<T>) => Promise<T>) {
  return {
    run_code: tool({
      description:
        "Save a script under code/ in the job's sandbox and run it from the job folder. Returns the exit code, stdout, stderr and the files it created or changed in outputs/.",
      inputSchema: z.object({
        filename: z.string().describe("A simple file name, e.g. simulate.py or build_model.py. Reusing a name replaces that script."),
        language: z.enum(["python", "node", "bash"]),
        code: z.string().min(1),
      }),
      execute: (input) => using(() => runCode(context, input)),
    }),
    run_command: tool({
      description: "Run a shell command in the job folder, e.g. to install a package or run run.sh.",
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: (input) => using(() => runShell(context, input)),
    }),
    read_file: tool({
      description: "Read a text file in the job folder (a path relative to /vercel/job) or the company drive (/vercel/drive/…).",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: (input) => using(() => readSandboxFile(context, input)),
    }),
    write_file: tool({
      description:
        "Write a text file in the job folder, e.g. config.yaml, run.sh or NOTES.md, or on the company drive (/vercel/drive/…).",
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: (input) => using(() => writeSandboxFile(context, input)),
    }),
    list_files: tool({
      description: "List the files in the job folder, or on the company drive.",
      inputSchema: z.object({ folder: z.enum(["job", "drive"]).optional().describe("job (the default) or drive.") }),
      execute: (input) => using(() => listSandboxFiles(context, input)),
    }),
    attach_file: tool({
      description:
        "Attach a file from the sandbox (usually in outputs/) to the task as a deliverable people can open. A file with the same name as one already on the task becomes its next version.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path relative to /vercel/job, e.g. outputs/portfolio-model.xlsx, or on /vercel/drive."),
        note: z.string().optional().describe("What this version is, e.g. 'rules ABD' or '70/30 mix'."),
      }),
      execute: (input) => using(() => attachSandboxFile(context, input)),
    }),
  } satisfies ToolSet;
}

function integrationTools(context: RunContext, sources: string[], using: <T>(work: () => Promise<T>) => Promise<T>): ToolSet {
  if (sources.length === 0) return {};
  const name = z.enum(sources as [string, ...string[]]);
  return {
    call_api: tool({
      description:
        "Call one of the company's data sources over HTTP. The request is signed for you; you never handle credentials. Read-only sources allow only GET. Pass save_as to write the whole response to a file in your sandbox or on the drive instead of reading it here.",
      inputSchema: z.object({
        integration: name,
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        path: z.string().min(1).describe("A path under the base URL, e.g. /v1/portfolios, or a full URL on its domain."),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional().describe("A JSON body, for write requests."),
        save_as: z.string().optional().describe("e.g. inputs/positions.json or /vercel/drive/masttro/positions-2026-10-07.json"),
      }),
      execute: (input) => (input.save_as ? using(() => callApi(context, input)) : callApi(context, input)),
    }),
    read_integration_guide: tool({
      description: "Read how to use one of the company's integrations: its base URL, access, and the guide agents keep for it.",
      inputSchema: z.object({ integration: name }),
      execute: (input) => readIntegrationGuide(context, input),
    }),
    save_integration_guide: tool({
      description:
        "Replace an integration's guide with what you've learned (endpoints that work, paging, field meanings, gotchas), so the next agent doesn't have to rediscover it. Read the current guide first and keep what's still true.",
      inputSchema: z.object({ integration: name, guide: z.string().min(1).describe("Markdown.") }),
      execute: (input) => saveIntegrationGuide(context, input),
    }),
  } satisfies ToolSet;
}

function browserTools(
  context: RunContext,
  logins: string[],
  using: <T>(work: () => Promise<T>) => Promise<T>,
  end: (outcome: RunOutcome) => void,
): ToolSet {
  if (logins.length === 0) return {};
  return {
    browser_login: tool({
      description:
        "Sign this job's browser in to one of the company's website logins with its saved credentials (you never see them), or finish a sign-in that was waiting for a code. Returns where the signed-in session is for your Playwright scripts. If the site asks for a sign-in code, the people on the task are asked for it and your run ends; call this again on your next run.",
      inputSchema: z.object({ login: z.enum(logins as [string, ...string[]]) }),
      execute: (input) =>
        using(async () => {
          const result = await browserLogin(context, input);
          if (!result.needsCode) return result.text;
          const asked = await askForLoginCode(context, result.needsCode);
          end({ type: "asked" });
          return asked;
        }),
    }),
  };
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
  const using = sandboxUser(context, state);

  try {
    const agent = new WorkflowAgent({
      model: options.model ?? begun.model,
      instructions: begun.instructions,
      tools: {
        ...runTools(context, begun.otherAgents, (outcome) => (state.outcome = outcome)),
        ...sandboxTools(context, using),
        ...integrationTools(context, begun.sources, using),
        ...browserTools(context, begun.logins, using, (outcome) => (state.outcome = outcome)),
        ...(options.research === false ? {} : researchTools()),
        use_skill: skillTool(),
      },
      // A run also ends when a tool ended it (e.g. a sign-in that asked for a code).
      stopWhen: [isStepCount(40), hasToolCall("ask", "finish", "hand_off"), () => state.outcome !== undefined],
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
