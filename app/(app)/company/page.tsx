import { CompanyProfile } from "@/components/company-profile";
import { PageHeader } from "@/components/page-header";
import { onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";

// What the Chief of Staff knows about the company: the profile it keeps.
// Reached from the company menu and the Chief of Staff panel; the company's
// settings are in Settings.
export default async function CompanyPage() {
  const { organization } = await requireAppContext();
  const profile = await loadProfile(organization.id);
  return (
    <>
      <PageHeader title="Company profile" />
      <CompanyProfile
        profile={profile}
        checklist={onboardingChecklist(profile)}
        onboarded={Boolean(organization.onboardingCompletedAt)}
      />
    </>
  );
}
