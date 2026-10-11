import { Integrations, type IntegrationView } from "@/components/integrations";
import { integrationSkill } from "@/lib/company-skills";
import { listIntegrations, recentCalls, type ApiConfig, type LoginConfig } from "@/lib/integrations";
import { listPeople } from "@/lib/people";
import { requireAppContext } from "@/lib/session";

// @map Settings → Integrations | Company menu → Settings → Integrations | The company's data sources and website logins: credentials are entered here (never in a chat), plus whose work may use each (every agent can), each one's skill (how it works), and testing them.
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

// Settings → Integrations: data sources and website logins agents can use.
export default async function IntegrationsSettingsPage() {
  const { organization, isAdmin } = await requireAppContext();
  const [integrations, people] = await Promise.all([listIntegrations(organization.id), listPeople(organization.id)]);
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
      personIds: i.personIds,
      skill: await integrationSkill(organization.id, i.id).then((s) => s && { name: s.name, version: s.version, body: s.body }),
      status: i.status,
      statusDetail: i.statusDetail,
      hasCredentials: i.hasCredentials,
      hasSession: i.hasSession,
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
    <section>
      <h2 className="text-[17px] font-medium tracking-tight">Integrations</h2>
      <p className="mt-1 mb-5 max-w-xl text-sm text-muted">
        The company&apos;s other systems, connected so agents can use them without seeing the credentials: APIs agents read
        (and write, if you allow it), and website logins for sites without one. Ask the Chief of Staff to connect either.
      </p>
      <Integrations
        integrations={views}
        people={people.map((p) => ({ id: p.id, name: p.name }))}
        canChoosePeople={isAdmin}
      />
    </section>
  );
}
