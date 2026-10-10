import { AiKeyRow, CompanyModelsForm } from "@/components/ai-settings";
import { SettingsGroup } from "@/components/setting-row";
import { AI_PROVIDERS, listAiKeys, providerOf } from "@/lib/ai/keys";
import { modelChoices } from "@/lib/models";
import { requireAppContext } from "@/lib/session";

// Settings → AI: the company's own keys with AI providers (bring your own
// key), so model usage is billed to its accounts, and which models its Chief
// of Staff and agents run on by default.
export default async function AiSettingsPage() {
  const { organization, isAdmin } = await requireAppContext();
  const [keys, choices] = await Promise.all([listAiKeys(organization.id), modelChoices()]);
  const fallback = {
    chiefOfStaff: process.env.CHIEF_OF_STAFF_MODEL ?? "",
    agents: process.env.AGENT_MODEL || process.env.CHIEF_OF_STAFF_MODEL || "",
  };
  const covered = new Set(keys.map((k) => k.provider));
  const inUse = [organization.models.chiefOfStaff || fallback.chiefOfStaff, organization.models.agents || fallback.agents].filter(Boolean);
  const onMach1 = [...new Set(inUse.map(providerOf).filter((p) => !covered.has(p)))];
  return (
    <>
      <SettingsGroup
        title="Your AI keys"
        description="Bring your own key: with a provider's key here, your Chief of Staff and agents use your account with that provider, so it bills you directly. Without one, they run on Mach1's. Keys are checked with the provider, stored encrypted, and never shown again or given to an agent."
      >
        {AI_PROVIDERS.map((provider) => {
          const key = keys.find((k) => k.provider === provider.slug);
          return (
            <AiKeyRow
              key={provider.slug}
              provider={provider}
              saved={key ? { hint: key.hint, addedAt: key.createdAt.toISOString() } : null}
              canEdit={isAdmin}
            />
          );
        })}
      </SettingsGroup>
      <SettingsGroup
        title="Default models"
        description={
          <>
            What your Chief of Staff and agents run on, unless an agent has its own (on its page). Pick models from a provider you
            brought a key for to use your own account.
            {keys.length > 0 && onMach1.length > 0 && (
              <span className="mt-2 block text-warn">
                Some of your models are from {onMach1.join(", ")}, which you haven&apos;t brought a key for: those run on Mach1&apos;s account.
              </span>
            )}
          </>
        }
      >
        <div className="py-4">
          <CompanyModelsForm models={organization.models} fallback={fallback} choices={choices} canEdit={isAdmin} />
        </div>
      </SettingsGroup>
    </>
  );
}
