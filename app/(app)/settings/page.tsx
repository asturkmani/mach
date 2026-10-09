import { AutoJoinToggle } from "@/components/auto-join-toggle";
import { DeleteCompany } from "@/components/delete-company";
import { SettingRow, SettingsGroup } from "@/components/setting-row";
import { requireAppContext } from "@/lib/session";

// Settings → General: the company's details, and deleting it at the bottom.
export default async function GeneralSettingsPage() {
  const { organization, isAdmin } = await requireAppContext();
  return (
    <>
      <SettingsGroup title="General">
        <SettingRow title="Company name" description={organization.name} />
        <SettingRow
          title="Website"
          description={
            organization.website ? (
              <a href={organization.website} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
                {organization.website.replace(/^https?:\/\//, "")}
              </a>
            ) : (
              "None"
            )
          }
        />
        <SettingRow
          title="Email domain"
          description={
            organization.domain
              ? `@${organization.domain}. People who sign up with it are pointed to this company.`
              : "None. The company was created with a personal email address, so it doesn't claim one."
          }
        />
        {organization.domain && (
          <SettingRow
            title="Colleagues join on their own"
            description={
              organization.autoJoin
                ? `On: anyone who signs in with a verified @${organization.domain} email joins as a member, without asking.`
                : `Off: colleagues with an @${organization.domain} email ask to join, and an admin lets them in from their inbox.`
            }
            action={isAdmin ? <AutoJoinToggle on={organization.autoJoin} domain={organization.domain} /> : undefined}
          />
        )}
      </SettingsGroup>
      {isAdmin && (
        <SettingsGroup>
          <DeleteCompany name={organization.name} />
        </SettingsGroup>
      )}
    </>
  );
}
