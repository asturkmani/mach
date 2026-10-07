import { Onboarding } from "@/components/onboarding";
import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import { getOrCreateChat } from "@/lib/chats";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";

export default async function ChiefOfStaffPage() {
  const { organization, user } = await requireAppContext();
  const [chat, profile] = await Promise.all([
    getOrCreateChat<ChiefOfStaffMessage>(organization.id, user.id),
    loadProfile(organization.id),
  ]);
  return (
    <Onboarding
      chatId={chat.id}
      initialMessages={chat.messages}
      initialProfile={profile}
      initiallyComplete={Boolean(organization.onboardingCompletedAt)}
    />
  );
}
