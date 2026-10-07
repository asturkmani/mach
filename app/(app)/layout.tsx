import { AppFrame } from "@/components/shell/app-frame";
import { LiveRefresh } from "@/components/shell/live-refresh";
import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import { listAgents } from "@/lib/agents/store";
import { getOrCreateChat } from "@/lib/chats";
import { listPeople } from "@/lib/people";
import { onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";
import { anyRunning, countInbox, listInProgress, listSuggestionStatuses } from "@/lib/tasks";

// Agent runs started from this section's server actions continue after the
// response (see lib/agents/dispatch.ts) and may take a few minutes.
export const maxDuration = 300;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { organization, user, person, isAdmin } = await requireAppContext();
  const [chat, profile, people, agents, inboxCount, inProgress, suggestionStatus, running] = await Promise.all([
    getOrCreateChat<ChiefOfStaffMessage>(organization.id, user.id),
    loadProfile(organization.id),
    listPeople(organization.id),
    listAgents(organization.id),
    countInbox(organization.id, person.id),
    listInProgress(organization.id, person.id),
    listSuggestionStatuses(organization.id, person.id),
    anyRunning(organization.id),
  ]);

  return (
    <AppFrame
      data={{
        me: { personId: person.id, name: person.name, email: user.email, isAdmin },
        organization: { name: organization.name, onboarded: Boolean(organization.onboardingCompletedAt) },
        people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
        agents: agents.filter((a) => a.kind === "defined" && a.status === "active").map((a) => ({ id: a.id, name: a.name, role: a.role })),
        inboxCount,
        inProgressCount: inProgress.length,
      }}
      cos={{
        chatId: chat.id,
        initialMessages: chat.messages,
        checklist: onboardingChecklist(profile),
        suggestionStatus,
      }}
    >
      <LiveRefresh active={running} />
      {children}
    </AppFrame>
  );
}
