import { byokCredentials } from "@/lib/ai/keys";
import { lineupFor, type Lineup } from "@/lib/ai/lineup";

/**
 * What AI Gateway is told with each of a company's model calls: its own
 * provider keys (if it brought any), and who the call was for, so usage can
 * be reported per company; and which lineup its models come from (Claude
 * with an Anthropic key). A step, so a workflow's bundle never loads the
 * database; it's only ever called from inside a model call (CompanyModel),
 * where it runs as an ordinary function and nothing it returns is recorded.
 */
export async function companyGatewayOptions(organizationId: string): Promise<{ gateway: Record<string, unknown>; lineup: Lineup }> {
  "use step";
  const byok = await byokCredentials(organizationId);
  return {
    gateway: { user: organizationId, tags: [`org:${organizationId}`], ...(Object.keys(byok).length ? { byok } : {}) },
    lineup: lineupFor(Object.keys(byok)),
  };
}
