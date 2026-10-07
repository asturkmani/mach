import { AppFrame } from "@/components/shell/app-frame";
import { LiveRefresh } from "@/components/shell/live-refresh";
import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import { listAgents } from "@/lib/agents/store";
import { getOrCreateChat } from "@/lib/chats";
import { listPeople } from "@/lib/people";
import { onboardingChecklist } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { requireAppContext } from "@/lib/session";
import { listIntegrations } from "@/lib/integrations";
import { anyRunning, listInbox, listInProgress, listSuggestionStatuses, listWorking } from "@/lib/tasks";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { organization, user, person, isAdmin } = await requireAppContext();
  const [chat, profile, people, agents, inbox, inProgress, suggestionStatus, running, integrations, working] = await Promise.all([
    getOrCreateChat<ChiefOfStaffMessage>(organization.id, user.id),
    loadProfile(organization.id),
    listPeople(organization.id),
    listAgents(organization.id),
    listInbox(organization.id, person.id),
    listInProgress(organization.id, person.id),
    listSuggestionStatuses(organization.id, person.id),
    anyRunning(organization.id),
    listIntegrations(organization.id),
    listWorking(organization.id),
  ]);

  return (
    <AppFrame
      data={{
        me: { personId: person.id, name: person.name, email: user.email, isAdmin },
        organization: {
          name: organization.name,
          onboarded: Boolean(organization.onboardingCompletedAt),
          timezone: organization.timezone,
        },
        people: people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
        agents: agents.filter((a) => a.kind === "defined" && a.status === "active").map((a) => ({ id: a.id, name: a.name, role: a.role })),
        inboxCount: inbox.length,
        inbox: inbox.map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          summary: t.summary,
          status: t.status,
          updatedAt: new Date(t.updatedAt).toISOString(),
        })),
        inProgressCount: inProgress.length,
        working: working.map((w) => ({ ...w, since: w.since ? new Date(w.since).toISOString() : null })),
      }}
      cos={{
        chatId: chat.id,
        initialMessages: chat.messages,
        checklist: onboardingChecklist(profile),
        suggestionStatus,
        integrationStatus: Object.fromEntries(
          integrations.map((i) => [i.id, { status: i.status, detail: i.statusDetail, hasCredentials: i.hasCredentials }]),
        ),
      }}
    >
      <LiveRefresh running={running} />
      {children}
    </AppFrame>
  );
}
