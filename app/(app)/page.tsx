import { Onboarding } from "@/components/onboarding";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";

export default async function ChiefOfStaffPage() {
  const { organization } = await requireAppContext();
  return (
    <Onboarding
      initialProfile={await loadProfile(organization.id)}
      initiallyComplete={Boolean(organization.onboardingCompletedAt)}
    />
  );
}
