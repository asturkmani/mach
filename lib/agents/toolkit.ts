import { gateway, tool, type ToolSet } from "ai";
import { z } from "zod";

import { runBrowserAgent, type BrowserReport } from "@/lib/agents/browser-agent";
import { browserLogin, browsePage } from "@/lib/agents/browser-steps";
import { githubRequest } from "@/lib/agents/github-steps";
import { callApi } from "@/lib/agents/integration-steps";
import type { AgentContext } from "@/lib/agents/prompts";
import { insightTools } from "@/lib/research/tools";
import { listSandboxFiles, readSandboxFile, runCode, runShell, startSandbox, writeSandboxFile } from "@/lib/agents/sandbox-steps";

export { skillTool } from "@/lib/agents/skills";

// The tools every agent has, whether it works on a task (workers and defined
// agents) or with people in the chat (the Chief of Staff): research, the
// company's data sources, a sandbox to run code in, and a browser in it. Each
// runtime adds the tools of its role on top: finishing and asking on a task,
// or creating tasks, agents and integrations in the chat.

/** A run's use of its sandbox: started on its first sandbox tool, closed when the run ends. */
export type SandboxSession = { used?: boolean; started?: Promise<string> };

export type SandboxUser = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Wraps sandbox work: the first sandbox tool in a run starts (or resumes) the
 * agent's sandbox, connects data sources and syncs the company drive into it.
 */
export function sandboxUser(context: AgentContext, session: SandboxSession): SandboxUser {
  return async <T>(work: () => Promise<T>) => {
    session.used = true;
    session.started ??= startSandbox(context).catch((error) => {
      session.started = undefined; // the next sandbox tool tries again
      throw error;
    });
    await session.started;
    return work();
  };
}

/**
 * Research: web search and page reading, run by AI Gateway and billed to its
 * credits (a few dollars per thousand calls), plus market data, X and Reddit
 * (lib/research), each able to look only at the sources people saved as high signal.
 */
export const researchTools = (context: AgentContext) =>
  ({
    web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
    fetch_page: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true, proxies: false }),
    ...insightTools(context),
  }) satisfies ToolSet;

export function sandboxTools(context: AgentContext, using: SandboxUser) {
  const where = context.taskId ? "the job's sandbox" : "your sandbox";
  return {
    run_code: tool({
      description: `Save a script under code/ in ${where} and run it from its folder (/vercel/job). Returns the exit code, stdout, stderr and the files it created or changed in outputs/.`,
      inputSchema: z.object({
        filename: z.string().describe("A simple file name, e.g. simulate.py or build_model.py. Reusing a name replaces that script."),
        language: z.enum(["python", "node", "bash"]),
        code: z.string().min(1),
      }),
      execute: (input) => using(() => runCode(context, input)),
    }),
    run_command: tool({
      description: `Run a shell command in ${where}'s folder, e.g. to install a package${context.taskId ? " or run run.sh" : ""}.`,
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: (input) => using(() => runShell(context, input)),
    }),
    read_file: tool({
      description: `Read a text file in ${where}'s folder (a path relative to /vercel/job) or the company drive (/vercel/drive/…).`,
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: (input) => using(() => readSandboxFile(context, input)),
    }),
    write_file: tool({
      description: `Write a text file in ${where}'s folder${context.taskId ? ", e.g. config.yaml, run.sh or NOTES.md," : ""} or on the company drive (/vercel/drive/…).`,
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: (input) => using(() => writeSandboxFile(context, input)),
    }),
    list_files: tool({
      description: `List the files in ${where}'s folder, or on the company drive.`,
      inputSchema: z.object({ folder: z.enum(["job", "drive"]).optional().describe("job (the default: the sandbox's folder) or drive.") }),
      execute: (input) => using(() => listSandboxFiles(context, input)),
    }),
  } satisfies ToolSet;
}

/** An integration's slug: one of the given ones, or any (checked when called) when there's no list. */
const slugOf = (slugs: string[] | null) =>
  slugs?.length ? z.enum(slugs as [string, ...string[]]) : z.string().min(1).describe("The integration's slug.");

/** The company's data sources (call_api) and the guides agents keep for every integration. */
export function integrationTools(
  context: AgentContext,
  using: SandboxUser,
  /** The data sources and logins this agent may use, or null for all of them (the Chief of Staff). */
  allowed: { sources: string[]; logins: string[] } | null,
): ToolSet {
  const sources = allowed?.sources ?? null;
  return {
    ...(sources === null || sources.length
      ? {
          call_api: tool({
            description:
              "Call one of the company's data sources over HTTP. The request is signed for you; you never handle credentials. Read-only sources allow only GET. Pass save_as to write the whole response to a file in your sandbox or on the drive instead of reading it here.",
            inputSchema: z.object({
              integration: slugOf(sources),
              method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
              path: z.string().min(1).describe("A path under the base URL, e.g. /v1/portfolios, or a full URL on its domain."),
              query: z.object({}).catchall(z.union([z.string(), z.number(), z.boolean()])).optional(),
              body: z.unknown().optional().describe("A JSON body, for write requests."),
              save_as: z.string().optional().describe("e.g. inputs/positions.json or /vercel/drive/masttro/positions-2026-10-07.json"),
            }),
            execute: (input) => (input.save_as ? using(() => callApi(context, input)) : callApi(context, input)),
          }),
        }
      : {}),
  };
}

/** What browser_login returns: the text the model reads, and the site waiting for a sign-in code, if one is. */
export type LoginOutput = { text: string; needsCode?: { slug: string; name: string } };

/**
 * The browser in the agent's sandbox: signing in to the company's website
 * logins, and reading pages (signed in, when there's a login for the site).
 * `onCode` is what the runtime does when a site asks for a sign-in code.
 */
export function browserTools(
  context: AgentContext,
  using: SandboxUser,
  /** The website logins this agent may use, or null for all of them (the Chief of Staff). */
  logins: string[] | null,
  onCode: (login: { slug: string; name: string }) => Promise<LoginOutput> | LoginOutput,
  /** durable: the caller is a task's agent run (a workflow); heartbeat keeps its lease and says when to stop. */
  options: { durable: boolean; heartbeat?: () => Promise<boolean> } = { durable: false },
): ToolSet {
  return {
    use_browser: tool({
      description: `Hand a job in a web browser to the browser agent, which sees the page in screenshots and clicks, types and reads like a person: anything interactive on a website (working in a web app, filling forms, signed-in work, checking what a page shows). Give one bounded job with the start URL, the company login to use, everything it needs to know, and any change people have explicitly approved; it won't submit, delete or send anything the job doesn't clearly ask for. It reports back with a status, what it saw, and screenshots (also saved with the files). It keeps its browser and memory per session: pass session and message to answer its question, ask what it saw, or give the next step.${
        context.taskId
          ? " If the site wants a sign-in code, the people on the task are asked for it and your run ends; continue the session on your next run."
          : " If the site wants a sign-in code, they get a card to enter it; when they say it's entered, continue the session."
      } For reading a page, browse is quicker.`,
      inputSchema: z.object({
        task: z.string().optional().describe("A new job: what to do and what to report, with all the context it needs (it can't see your conversation)."),
        start_url: z.string().optional(),
        login: logins ? z.enum(["", ...logins] as [string, ...string[]]).optional() : z.string().optional(),
        session: z.string().optional().describe("Continue this session (from an earlier result) instead of starting a new job."),
        message: z.string().optional().describe("With session: your answer, question or next instruction."),
      }),
      execute: (input) =>
        using(async (): Promise<BrowserReport & { codeText?: string }> => {
          const report = await runBrowserAgent(context, using, { ...input, login: input.login || undefined }, { ...options, logins });
          if (!report.needsCode) return report;
          const asked = await onCode(report.needsCode);
          return { ...report, codeText: asked.text };
        }),
      toModelOutput: ({ output }) => ({
        type: "content" as const,
        value: [
          {
            type: "text" as const,
            text: [
              `Browser agent (session ${output.session}): ${output.status}.`,
              output.message,
              output.question ? `Question: ${output.question}` : "",
              output.codeText ?? "",
              ...output.evidence.map((e) => `Screenshot "${e.name}": ${e.caption}${e.versionId ? " (saved with the files)" : ""}`),
            ]
              .filter(Boolean)
              .join("\n"),
          },
          ...output.evidence
            .filter((e) => e.image)
            .map((e) => ({ type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: e.image! } })),
        ],
      }),
    }),
    ...(logins === null || logins.length
      ? {
          browser_login: tool({
            description: `Sign the browser in your sandbox in to one of the company's website logins with its saved credentials (you never see them), or finish a sign-in that was waiting for a code. Returns where the signed-in session is for your Playwright scripts; browse uses it by itself.${
              context.taskId
                ? " If the site asks for a sign-in code, the people on the task are asked for it and your run ends; call this again on your next run."
                : " If the site asks for a sign-in code, they get a card to enter it; when they say it's entered, call this again."
            }`,
            inputSchema: z.object({
              login: slugOf(logins),
              again: z.boolean().optional().describe("Sign in again from the start, e.g. because the site signed you out."),
            }),
            execute: (input): Promise<LoginOutput> =>
              using(async () => {
                const result = await browserLogin(context, input);
                return result.needsCode ? onCode(result.needsCode) : { text: result.text };
              }),
            toModelOutput: ({ output }) => ({ type: "text" as const, value: output.text }),
          }),
        }
      : {}),
    browse: tool({
      description:
        "Open a page in the browser in your sandbox and read it, including pages that need JavaScript or a sign-in (it uses the session of the company's login for that site, if there is one). Returns the page's text and links, or the body of a JSON response, and the data the page loaded: an API docs page (Swagger, Redoc) lists its spec there, which you can then browse with save_as and read with code.",
      inputSchema: z.object({
        url: z.string().min(1).describe("A full URL."),
        save_as: z.string().optional().describe("Keep the whole page or response as a file in your sandbox's folder, e.g. inputs/openapi.json."),
      }),
      execute: (input) => using(() => browsePage(context, input)),
    }),
  };
}

/** GitHub as the person this work is for: their pull requests, issues, repositories. */
export function githubTools(context: AgentContext): ToolSet {
  return {
    github_api: tool({
      description:
        "Call GitHub's REST API (https://api.github.com) as the person this work is for, with their own GitHub: e.g. GET /user/repos, GET /repos/{owner}/{repo}/pulls, POST /repos/{owner}/{repo}/pulls to open a pull request. Only repositories they let Mach1 use are reachable. Merge (PUT …/pulls/{n}/merge) only when they've said to.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        path: z.string().min(1).describe("An API path, e.g. /repos/acme/site/pulls?state=open"),
        body: z.unknown().optional().describe("A JSON body, for write requests."),
      }),
      execute: (input) => githubRequest(context, input),
    }),
  };
}