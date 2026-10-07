import { CompanyProfile } from "@/components/company-profile";
import { DeleteCompany } from "@/components/delete-company";
import { PageHeader } from "@/components/page-header";
import { onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";

export default async function CompanyPage() {
  const { organization, isAdmin } = await requireAppContext();
  const profile = await loadProfile(organization.id);
  return (
    <>
      <PageHeader title="Company profile" />
      <CompanyProfile
        profile={profile}
        checklist={onboardingChecklist(profile)}
        onboarded={Boolean(organization.onboardingCompletedAt)}
      />
      {isAdmin && (
        <div className="px-4 pb-12 sm:px-8">
          <DeleteCompany name={organization.name} />
        </div>
      )}
    </>
  );
}
