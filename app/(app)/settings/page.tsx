import { DeleteCompany } from "@/components/delete-company";
import { SettingRow, SettingsGroup } from "@/components/setting-row";
import { requireAppContext } from "@/lib/session";

// @map Settings → General | Company menu (top left) → Settings | The company's details (name, website), and deleting the company (admins).
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
      </SettingsGroup>
      {isAdmin && (
        <SettingsGroup>
          <DeleteCompany name={organization.name} />
        </SettingsGroup>
      )}
    </>
  );
}
