import { gateway, tool, type ToolSet } from "ai";
import { z } from "zod";

import { browserLogin, browsePage } from "@/lib/agents/browser-steps";
import { callApi, readIntegrationGuide, saveIntegrationGuide } from "@/lib/agents/integration-steps";
import type { AgentContext } from "@/lib/agents/prompts";
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

/** Web search and page reading, run by AI Gateway and billed to its credits (a few dollars per thousand calls). */
export const researchTools = () =>
  ({
    web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
    fetch_page: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true, proxies: false }),
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
  const all = allowed ? [...allowed.sources, ...allowed.logins] : null;
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
              query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
              body: z.unknown().optional().describe("A JSON body, for write requests."),
              save_as: z.string().optional().describe("e.g. inputs/positions.json or /vercel/drive/masttro/positions-2026-10-07.json"),
            }),
            execute: (input) => (input.save_as ? using(() => callApi(context, input)) : callApi(context, input)),
          }),
        }
      : {}),
    ...(all === null || all.length
      ? {
          read_integration_guide: tool({
            description: "Read how to use one of the company's integrations: its base URL or sign-in page, access, and the guide agents keep for it.",
            inputSchema: z.object({ integration: slugOf(all) }),
            execute: (input) => readIntegrationGuide(context, input),
          }),
          save_integration_guide: tool({
            description:
              "Replace an integration's guide with what you've learned (endpoints that work, paging, field meanings, the steps through a web app, gotchas), so the next agent doesn't have to rediscover it. Read the current guide first and keep what's still true.",
            inputSchema: z.object({ integration: slugOf(all), guide: z.string().min(1).describe("Markdown.") }),
            execute: (input) => saveIntegrationGuide(context, input),
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
): ToolSet {
  return {
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
