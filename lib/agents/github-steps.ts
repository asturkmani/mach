import type { AgentContext } from "@/lib/agents/prompts";
import { appUrl } from "@/lib/app-url";
import { callGitHub, GitHubError, githubToken } from "@/lib/github";
import { getPerson } from "@/lib/people";

// GitHub's API as the person the agent works for (docs/github.md): the
// Chief of Staff's chat partner, or the person a task run is for. Their
// token is used here, server side; it never reaches the model.

export type GitHubRequest = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };

export async function githubRequest(context: AgentContext, input: GitHubRequest): Promise<string> {
  "use step";
  if (!context.personId) return "There's no one this work is for, so there's no GitHub to use.";
  const github = await githubToken(context.organizationId, context.personId);
  if (!github) {
    const person = await getPerson(context.organizationId, context.personId);
    return `${person?.name ?? "This person"} hasn't connected GitHub (or it needs connecting again). Ask them to connect theirs at ${appUrl("/connect/github")}, then try again. Never use anyone else's.`;
  }
  try {
    const result = await callGitHub(github.token, { method: input.method ?? "GET", path: input.path, body: input.body });
    return `${input.method ?? "GET"} ${input.path} → ${result.status} (as @${github.account.login})\n${result.body}`;
  } catch (error) {
    if (error instanceof GitHubError) return error.message;
    return `GitHub couldn't be reached: ${(error as Error).message}`;
  }
}
