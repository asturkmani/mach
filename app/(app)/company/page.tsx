import { CompanyProfile } from "@/components/company-profile";
import { DeleteCompany } from "@/components/delete-company";
import { ReachChiefOfStaff } from "@/components/reach-cos";
import { agentmailConfigured } from "@/lib/channels/agentmail";
import { whatsappNumber } from "@/lib/channels/twilio";
import { PageHeader } from "@/components/page-header";
import { onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";

export default async function CompanyPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  const profile = await loadProfile(organization.id);
  return (
    <>
      <PageHeader title="Company profile" />
      <CompanyProfile
        profile={profile}
        checklist={onboardingChecklist(profile)}
        onboarded={Boolean(organization.onboardingCompletedAt)}
      />
      <div className="px-4 pb-12 sm:px-8">
        <ReachChiefOfStaff
          whatsapp={whatsappNumber()}
          phone={person.phone}
          emailInbox={organization.emailInbox}
          email={person.email ?? ""}
          emailAvailable={agentmailConfigured()}
          isAdmin={isAdmin}
        />
        {isAdmin && <DeleteCompany name={organization.name} />}
      </div>
    </>
  );
}
