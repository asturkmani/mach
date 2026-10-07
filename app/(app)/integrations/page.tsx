import { Integrations, type IntegrationView } from "@/components/integrations";
import { PageHeader } from "@/components/page-header";
import { listAgents } from "@/lib/agents/store";
import { listIntegrations, recentCalls, type ApiConfig, type LoginConfig } from "@/lib/integrations";
import { requireAppContext } from "@/lib/session";

/** How requests are signed, by name only (header and query names, the token step's host): never values. */
function signing(config: ApiConfig): string {
  const parts = [
    ...Object.keys(config.headers ?? {}).map((h) => `${h} header`),
    ...Object.keys(config.query ?? {}).map((q) => `${q} query parameter`),
  ];
  if (config.token) {
    try {
      parts.push(`a token from ${new URL(config.token.url.replace(/\{\{[^}]+\}\}/g, "x")).host}`);
    } catch {
      parts.push("a token");
    }
  }
  return parts.join(", ");
}

export default async function IntegrationsPage() {
  const { organization } = await requireAppContext();
  const [integrations, agents] = await Promise.all([listIntegrations(organization.id), listAgents(organization.id)]);
  const views: IntegrationView[] = await Promise.all(
    integrations.map(async (i) => ({
      id: i.id,
      kind: i.kind,
      slug: i.slug,
      name: i.name,
      description: i.description,
      url: i.kind === "api" ? (i.config as ApiConfig).baseUrl : (i.config as LoginConfig).loginUrl,
      domains: i.config.domains,
      signing: i.kind === "api" ? signing(i.config as ApiConfig) : "",
      fields: i.config.fields,
      access: i.access,
      agentIds: i.agentIds,
      guide: i.guide,
      status: i.status,
      statusDetail: i.statusDetail,
      hasCredentials: i.hasCredentials,
      lastUsedAt: i.lastUsedAt ? new Date(i.lastUsedAt).toISOString() : null,
      calls: (await recentCalls(i.id, 10)).map((c) => ({
        method: c.method,
        path: c.path,
        status: c.status,
        by: c.agentName ?? c.personName ?? "",
        taskNumber: c.taskNumber,
        at: new Date(c.createdAt).toISOString(),
      })),
    })),
  );

  return (
    <>
      <PageHeader title="Integrations" count={views.length} />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-4xl space-y-6">
          <p className="max-w-2xl text-[15px] text-muted">
            The company&apos;s other systems, connected so agents can use them. Data sources are APIs agents read (and, if you
            allow it, write) without ever seeing the credentials. Ask the Chief of Staff to connect one from its API docs.
          </p>
          <Integrations
            integrations={views}
            agents={agents.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name }))}
          />
        </div>
      </div>
    </>
  );
}
