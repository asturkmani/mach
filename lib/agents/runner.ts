import { WorkflowAgent } from "@ai-sdk/workflow";

import { startFollowersStep } from "@/lib/agents/follower-steps";
import { CompanyModel } from "@/lib/ai/company-model";
import { isStepCount, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

import { SUMMARY_MAX, type RunContext, type RunOutcome } from "@/lib/agents/prompts";
import {
  agentForLatestMessage,
  askForApproval,
  askPeople,
  beginRun,
  endRun,
  finishWork,
  keepLease,
  logRun,
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
import { pageTools } from "@/lib/agents/page-tools";
import { attachSandboxFile, closeSandbox, writeSkillScripts } from "@/lib/agents/sandbox-steps";
import {
  batchFor,
  cancelChild,
  cantWait,
  closeChildren,
  collectFile,
  escalateTask,
  messageChild,
  readChild,
  startChild,
  stillWorking,
  waitForChildren,
  wakeJobStep,
} from "@/lib/agents/job-steps";
import { exaTools } from "@/lib/research/tools";
import { findSkillTool, getSkill, SKILL_TOOLS, SKILLS, toolsOf } from "@/lib/agents/skills";
import { trimToolResults } from "@/lib/agents/trim";
import { stepOf, type RunStep } from "@/lib/learning/run-log";
import { checkGate } from "@/lib/agents/gates";
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

type RunState = SandboxSession & {
  outcome?: RunOutcome;
  /** What it did, for the run log. */
  steps?: RunStep[];
  modelSteps?: number;
  loaded?: Set<string>;
  /** The batch a coordinator's children started in this run belong to. */
  batch?: number;
};

const childNumber = z.number().int().positive().describe("The child's task number.");

/** A job's coordinator's tools: its children, and ending its run to wait for them. */
function jobTools(context: RunContext, state: RunState, end: (outcome: RunOutcome) => void) {
  const batch = async () => (state.batch ??= await batchFor(context));
  // Children start one at a time, even when called together, so each sees those before it: the batch's size, the round's cost.
  let starting: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(start: () => Promise<T>): Promise<T> => {
    const next = starting.then(start, start);
    starting = next.catch(() => {});
    return next;
  };
  return {
    start_child: tool({
      description:
        "Start part of the job as a child task: for the Worker (with the skills that part needs), for one person on the team (a question, or a list to go through), or a script: one of a skill's scripts, run without a model (the Worker steps in only if it fails). The children you start in one run are a batch. The child can't see this job: its brief carries everything.",
      inputSchema: z.object({
        assignee: z.enum(["worker", "person", "script"]),
        person: z.string().optional().describe("For a person's child: their exact name."),
        script: z
          .object({
            skill: z.string().min(1).describe("The skill the script is in."),
            path: z.string().min(1).describe("The script, as the skill lists it, e.g. pull_untagged.py."),
            args: z.array(z.string()).optional(),
          })
          .optional()
          .describe("For a script child."),
        title: z.string().min(1).max(100).describe("The outcome, starting with a verb."),
        brief: z
          .string()
          .min(1)
          .describe("What to do, the inputs (files, data sources, earlier children's results), what done looks like and what to report back. Everything it needs: it can't see the job."),
        skills: z.array(z.string()).optional().describe("For the Worker: the skills this part needs, Mach1's or the company's (find_skill)."),
        after: z.array(z.number().int().positive()).optional().describe("Numbers of this job's children it needs first: it starts once they're delivered."),
        files: z.array(z.string()).optional().describe("Names of files on this job it should start from."),
      }),
      execute: (input) => inTurn(async () => startChild(context, input, await batch())),
    }),
    message_child: tool({
      description:
        "Write on a child: answer its question, or send it back with exactly what to redo. A Worker's child goes back to work; a person's child asks them again.",
      inputSchema: z.object({ child: childNumber, text: z.string().min(1) }),
      execute: async (input) => messageChild(context, input, await batch()),
    }),
    cancel_child: tool({
      description: "Stop a child you no longer need, and any child that waits for it.",
      inputSchema: z.object({ child: childNumber, why: z.string().optional() }),
      execute: (input) => cancelChild(context, input),
    }),
    read_child: tool({
      description: "A child's full result or question, and its files (small text files in full).",
      inputSchema: z.object({ child: childNumber }),
      execute: (input) => readChild(context, input),
    }),
    collect_file: tool({
      description: "Put a child's deliverable on the job, so the job's report carries it.",
      inputSchema: z.object({ child: childNumber, name: z.string().min(1).describe("The file's name on the child.") }),
      execute: (input) => collectFile(context, input),
    }),
    wait_for_children: tool({
      description:
        "End your run to wait for the children you started or sent back. You wake when they're all in, or straight away when one asks something or fails.",
      inputSchema: z.object({
        note: z.string().optional().describe("A short note for the job's thread, e.g. the plan for this batch."),
        progress: reportFields.progress,
      }),
      execute: async (input) => {
        const why = await cantWait(context);
        if (why) return why;
        const result = await waitForChildren(context, input);
        end({ type: "waiting" });
        return result;
      },
    }),
  } satisfies ToolSet;
}

/** The tools of an agent on a task: delivering files, reporting, asking, escalating and scheduling. */
function taskTools(
  context: RunContext,
  using: SandboxUser,
  end: (outcome: RunOutcome) => void,
  { canEscalate = false }: { canEscalate?: boolean } = {},
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
    request_approval: tool({
      description:
        "Before changing anything outside Mach1 (writing to a data source, GitHub beyond a pull request, entering data on a website), ask the people on the task to approve exactly those changes: a numbered list, or a file with them. Ends your run; their Approve starts your next one. Then make each change with approval and its item number: a change outside the list is refused. A coordinator also asks this way for a plan whose cost is above the company's limit (kind cost).",
      inputSchema: z.object({
        what: z.string().min(1).max(300).describe("What these changes are, in a line, e.g. 'Tag 14 Masttro transactions'."),
        items: z
          .array(z.string().min(1).max(500))
          .max(200)
          .optional()
          .describe("The exact changes, one per item, e.g. 'Tag txn 4411 (ACME LTD, £1,200, 3 Oct) as Rent, Hassan Daher Holdings'."),
        file: z.string().optional().describe("Or the name of a file on this task with the exact changes (attach it first)."),
        kind: z.enum(["writes", "cost"]).optional().describe("cost: approving a plan whose estimate is above the company's limit."),
        estimate_usd: z.number().positive().optional().describe("For cost: the plan's estimate in dollars."),
        summary: reportFields.summary,
      }),
      execute: async (input) => {
        const result = await askForApproval(context, input);
        if (result.startsWith("Asked")) end({ type: "asked" });
        return result;
      },
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
    ...(canEscalate
      ? {
          escalate: tool({
            description:
              "Turn this task into a job when it needs a plan or needs to go wide (you found eight issues, not one, or the question splits into six). The Coordinator takes over, starting from what you found, and your run ends.",
            inputSchema: z.object({
              why: z.string().min(1).describe("Why one worker isn't enough, in a sentence."),
              found: z.string().min(1).describe("What you found so far, that the plan should start from."),
            }),
            execute: async (input) => {
              const coordinatorId = await escalateTask(context, input);
              end({ type: "handed_off", agentId: coordinatorId });
              return "It's a job now: the Coordinator takes it from here. Your run ends.";
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
    case "browser_login":
      return `Signing in to ${input.login}`;
    case "use_browser":
      return `Using the browser: ${clipped(input.task ?? input.message, 40)}`;
    case "save_page":
      return `Saving the ${clipped(input.title, 40)} page`;
    case "read_page":
      return `Reading the ${input.page} page`;
    case "refresh_page":
      return `Setting up the ${input.page} page's refresh`;
    case "post_update":
      return "Posting an update";
    case "set_schedule":
      return "Setting the schedule";
    case "stop_schedule":
      return "Stopping the schedule";
    case "find_skill":
      return `Looking for a skill: ${clipped(input.words, 40)}`;
    case "use_skill":
      return `Reading the ${input.name} playbook`;
    case "market_data":
      return `Looking up ${[input.symbols].flat().filter(Boolean).join(", ") || clipped(input.query, 30) || "market data"} (${input.action})`;
    case "x_search":
      return `Searching X: ${clipped(input.query, 40) || "the latest posts"}`;
    case "reddit_search":
      return `Searching Reddit: ${clipped(input.query, 40)}`;
    case "start_child":
      return `Starting: ${clipped(input.title, 48)}`;
    case "message_child":
      return `Writing to #${input.child}`;
    case "read_child":
      return `Reading #${input.child}`;
    case "cancel_child":
      return `Cancelling #${input.child}`;
    case "collect_file":
      return `Collecting ${fileName(input.name)} from #${input.child}`;
    case "wait_for_children":
      return "Waiting on the job's parts";
    case "escalate":
      return "Turning this into a job";
    case "ask":
      return "Writing a question";
    case "finish":
      return "Writing the report";
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
function narrated(
  context: RunContext,
  tools: ToolSet,
  interrupt: () => void,
  record?: (step: RunStep) => void,
  /** The kinds of write the skills in use are pre-approved for. */
  preApproved: () => string[] = () => [],
): ToolSet {
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
            const detail = activityFor(name, input ?? {});
            // A change outside Mach1 goes ahead only under an approval of exactly that content.
            const refused = await checkGate(context, name, input ?? {}, preApproved());
            if (refused) {
              record?.({ tool: name, detail, ok: false });
              return name === "use_browser" ? { status: "failed", message: refused, session: String(input?.session ?? ""), evidence: [] } : refused;
            }
            try {
              const result = await execute(input, options);
              record?.(stepOf(name, detail, result));
              return result;
            } catch (error) {
              record?.({ tool: name, detail, ok: false });
              throw error;
            }
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
  const state: RunState = { steps: [], modelSteps: 0 };
  const startedAt = new Date().toISOString();
  const catalogue = [...SKILLS, ...begun.companySkills];
  // Scripts of the skills pinned or loaded go into the sandbox the next time it's used, not before.
  const scripts = new Map<string, Record<string, string>>();
  const withScripts = (names: Iterable<string>) => {
    for (const name of names) {
      const found = getSkill(name, catalogue)?.scripts;
      if (found) scripts.set(name, found);
    }
  };
  withScripts(begun.skills);
  const sandbox = sandboxUser(context, state);
  const using: SandboxUser = (work) =>
    sandbox(async () => {
      if (scripts.size) {
        await writeSkillScripts(context, Object.fromEntries(scripts));
        scripts.clear();
      }
      return work();
    });
  const end = (ended: RunOutcome) => (state.outcome = ended);
  const interrupt = () => end({ type: "interrupted" });
  let outcome: RunOutcome | undefined;

  try {
    // The company's own provider keys ride along with each model call (bring your own key).
    const model = options.model ?? new CompanyModel(organizationId, begun.model);
    const research = options.research === false ? {} : { ...researchTools(context), ...exaTools() };
    // Skills loaded during the run switch on their tools from the next step (pinned ones from the start).
    state.loaded = new Set(begun.skills);
    const task = taskTools(context, using, end, { canEscalate: begun.canEscalate });
    const tools = narrated(
      context,
      begun.coordinating
        ? {
            // The coordinator runs the job: no sandbox, browser or research of its own; its children do the work.
            post_update: task.post_update,
            save_output: task.save_output,
            request_approval: task.request_approval,
            set_schedule: task.set_schedule,
            stop_schedule: task.stop_schedule,
            ask: task.ask,
            // The job reports once, at the end.
            finish: {
              ...task.finish,
              execute: async (input: Parameters<typeof task.finish.execute>[0], options: Parameters<typeof task.finish.execute>[1]) => {
                const busy = await stillWorking(context);
                if (busy) return busy;
                const reported = await task.finish.execute(input, options);
                await closeChildren(context);
                return reported;
              },
            },
            ...jobTools(context, state, end),
            use_skill: skillTool(catalogue, (names) => names.forEach((n) => state.loaded?.add(n))),
            find_skill: findSkillTool(catalogue),
          }
        : {
            ...task,
            ...sandboxTools(context, using),
            ...integrationTools(context, using, { sources: begun.sources, logins: begun.logins }),
            ...browserTools(context, using, begun.logins, async (login) => {
              // The people on the task are asked for the code; their reply finishes the sign-in on the next run.
              const asked = await askForLoginCode(context, login);
              end({ type: "asked" });
              return { text: asked, needsCode: login };
            }, { durable: true, heartbeat: () => keepLease(context, "Using the browser") }),
            ...githubTools(context),
            // On once building-pages is loaded: pages are made for the person the work is for.
            ...pageTools(context, using, { name: context.agentName, agentId: context.agentId, personId: context.personId }),
            ...research,
            use_skill: skillTool(catalogue, (names) => {
              names.forEach((n) => state.loaded?.add(n));
              withScripts(names);
            }),
            find_skill: findSkillTool(catalogue),
          },
      interrupt,
      (step) => state.steps?.push(step),
      () => [...(state.loaded ?? [])].flatMap((n) => getSkill(n, catalogue)?.preApproved ?? []),
    );
    // Tools a skill switches on stay off until one of its skills is pinned or loaded.
    const activeTools = () => {
      const on = new Set(toolsOf([...(state.loaded ?? [])], catalogue));
      return Object.keys(tools).filter((name) => !SKILL_TOOLS.has(name) || on.has(name));
    };
    const agent = new WorkflowAgent({
      model,
      instructions: begun.instructions,
      // No activeTools here: it would fix the set for the whole run. prepareStep picks them before every step.
      tools,
      // A run ends when a tool ended it: finish, ask, escalate, a sign-in that asked for a code. Not on the
      // call alone, since a coordinator's finish is refused while its children still work.
      stopWhen: [isStepCount(40), () => state.outcome !== undefined],
      // Long runs keep their lease fresh before each model call (and say they're thinking), and stop
      // there if a person pressed Send now.
      prepareStep: async ({ messages }) => {
        if (await keepLease(context, "Thinking")) {
          interrupt();
          throw new Interrupted();
        }
        state.modelSteps = (state.modelSteps ?? 0) + 1;
        const trimmed = trimToolResults(messages);
        return { activeTools: activeTools(), ...(trimmed === messages ? {} : { messages: trimmed }) };
      },
    });
    const result = await agent.generate({ prompt: withImages(begun.prompt, begun.images) });
    // A coordinator that stopped with words while its children work is waiting for them, not reporting.
    if (!state.outcome && begun.coordinating && !(await cantWait(context))) {
      await waitForChildren(context, { note: result.text });
      state.outcome = { type: "waiting" };
    }
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
    try {
      await logRun(context, {
        outcome: outcome?.type ?? "failed",
        skillsPinned: begun.skills,
        skillsLoaded: [...(state.loaded ?? [])].filter((n) => !begun.skills.includes(n)),
        steps: state.steps ?? [],
        modelSteps: state.modelSteps ?? 0,
        startedAt,
      });
    } catch (error) {
      console.error(`Couldn't log the run on task ${context.taskId}`, error);
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
    } else if (
      (outcome.type === "asked" || outcome.type === "finished" || outcome.type === "waiting") &&
      (await personCommentCount(taskId)) > commentsBefore
    ) {
      next = current;
    } else {
      next = undefined;
    }
  }
  await startFollowersStep(organizationId, taskId);
  // A job's child that delivered or needs an answer, or a job whose children came in during its run, wakes the job.
  await wakeJobStep(organizationId, taskId);
}
