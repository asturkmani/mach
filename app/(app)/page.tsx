import { cookies, headers } from "next/headers";

import { Home, type HomeScope, type HomeView } from "@/components/home";
import { OnboardingNote } from "@/components/onboarding-note";
import { requireAppContext } from "@/lib/session";
import { toView } from "@/lib/task-view";
import { listInbox, listTasks } from "@/lib/tasks";

// @map Home | Left menu → Home | What needs you first (Needs you), then all the company's work as a board or a list (?view=board or ?view=list), for everyone or just you. New task with +.
// Home: what needs this person, then all the company's work as a board or a
// list. The view and scope are remembered in cookies; ?view= overrides. A
// phone starts on the list, which suits a narrow screen; a computer on the board.
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const { organization, person } = await requireAppContext();
  const [params, jar, head] = await Promise.all([searchParams, cookies(), headers()]);
  const asked = typeof params.view === "string" ? params.view : jar.get("mach-home-view")?.value;
  const phone = head.get("sec-ch-ua-mobile") === "?1" || /iPhone|iPod|Android.*Mobile/.test(head.get("user-agent") ?? "");
  const view: HomeView = asked === "list" || asked === "board" ? asked : phone ? "list" : "board";
  const scope: HomeScope = jar.get("mach-home-scope")?.value === "mine" ? "mine" : "everyone";

  const [inbox, tasks] = await Promise.all([
    listInbox(organization.id, person.id),
    listTasks(organization.id, { closedLimit: 25, viewer: person.id }),
  ]);
  // Profile suggestions are approvals, not work: they only show under Needs you.
  const work = tasks.filter((t) => t.kind === "task" && t.status !== "cancelled");

  return (
    <Home
      view={view}
      scope={scope}
      needsYou={inbox.map((t) => toView(t))}
      work={work.map((t) => toView(t))}
      notice={!organization.onboardingCompletedAt ? <OnboardingNote /> : undefined}
    />
  );
}
