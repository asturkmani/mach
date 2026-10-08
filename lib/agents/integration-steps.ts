import type { AgentContext } from "@/lib/agents/prompts";
import { saveIntoSandbox } from "@/lib/agents/sandbox-steps";
import { addMessage } from "@/lib/tasks";
import { callIntegration, getIntegration, IntegrationError, updateIntegration, allowedFor, type ApiConfig, type CallRequest } from "@/lib/integrations";

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

export async function readIntegrationGuide(context: AgentContext, input: { integration: string }): Promise<string> {
  "use step";
  const integration = await getIntegration(context.organizationId, input.integration);
  if (!integration || !allowedFor(integration, context.agentId)) return `There's no integration called ${input.integration} you can use.`;
  const config = integration.config as ApiConfig;
  const how =
    integration.kind === "api"
      ? [
          `Base URL: ${config.baseUrl} (domains: ${config.domains.join(", ")})`,
          `Access: ${integration.access === "read" ? "read-only (GET)" : "read and write"}`,
          config.query && Object.keys(config.query).length
            ? "Signed with a query parameter, so call it with call_api (code in your sandbox can't add it)."
            : "Signed with headers: call it with call_api, or from code in your sandbox without auth headers (they're added on the way out).",
          config.docsUrl ? `Docs: ${config.docsUrl}` : "",
        ]
      : [`Sign-in page: ${(integration.config as { loginUrl: string }).loginUrl}`];
  return `# ${integration.name} (${integration.slug})\n${integration.description}\n\n${how.filter(Boolean).join("\n")}\nStatus: ${integration.status}${
    integration.statusDetail ? ` (${integration.statusDetail})` : ""
  }\n\n${integration.guide || "No guide yet. Once you've worked out how it behaves, save one with save_integration_guide."}`;
}

export async function saveIntegrationGuide(context: AgentContext, input: { integration: string; guide: string }): Promise<string> {
  "use step";
  const integration = await getIntegration(context.organizationId, input.integration);
  if (!integration || !allowedFor(integration, context.agentId)) return `There's no integration called ${input.integration} you can use.`;
  await updateIntegration(context.organizationId, integration.id, { guide: input.guide.slice(0, 20_000) });
  if (context.taskId) {
    await addMessage(context.taskId, {
      author: context.agentName,
      agentId: context.agentId ?? undefined,
      kind: "event",
      body: `Updated the ${integration.name} guide.`,
    });
  }
  return "Saved. Every agent that uses it will read this guide.";
}
