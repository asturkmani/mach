import type { AgentContext } from "@/lib/agents/prompts";
import { saveIntoSandbox } from "@/lib/agents/sandbox-steps";
import { integrationSkill } from "@/lib/company-skills";
import { allowedFor, callIntegration, getIntegration, IntegrationError, type CallRequest } from "@/lib/integrations";

// The integration tools an agent uses, each a durable workflow step. The
// agent never sees credentials: requests are signed here, or at the
// sandbox's network layer for its own code.

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…${text.length - max} more characters]` : text);

export async function callApi(
  context: AgentContext,
  input: CallRequest & { integration: string; save_as?: string },
): Promise<string> {
  "use step";
  try {
    const result = await callIntegration(
      context.organizationId,
      input.integration,
      { method: input.method, path: input.path, query: input.query, body: input.body },
      { taskId: context.taskId ?? undefined, agentId: context.agentId ?? undefined, personId: context.personId },
    );
    const head = `${input.method ?? "GET"} ${result.url} → ${result.status}${result.contentType ? ` (${result.contentType})` : ""}, ${result.body.length} bytes`;
    if (input.save_as) {
      const where = await saveIntoSandbox(context, input.save_as, result.body);
      return `${head}\nSaved to ${where}.${result.text ? `\nStart:\n${clip(result.text, 1500)}` : ""}`;
    }
    if (!result.text) return `${head}\nA binary response; pass save_as to keep it as a file.`;
    return `${head}\n${clip(result.text, 20_000)}${result.text.length > 20_000 ? "\nPass save_as to keep the whole response as a file." : ""}`;
  } catch (error) {
    if (error instanceof IntegrationError) return error.message;
    return `The request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A website login for the browser agent: where it signs in, and what its skill says about the site. */
export async function readSiteSkill(context: AgentContext, slug: string): Promise<string> {
  "use step";
  const integration = await getIntegration(context.organizationId, slug);
  if (!integration || !allowedFor(integration, context.personId)) return `There's no login called ${slug} you can use.`;
  const skill = await integrationSkill(context.organizationId, integration.id);
  return `# ${integration.name} (${integration.slug})\nSign-in page: ${(integration.config as { loginUrl?: string }).loginUrl ?? ""}\n\n${
    skill?.body ?? "Nothing is known about this site yet. Say what you learn in your report."
  }`;
}
