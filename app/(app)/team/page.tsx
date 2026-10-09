import Link from "next/link";

import { AgentForm } from "@/components/agent-form";
import { PageHeader } from "@/components/page-header";
import { TeamSection } from "@/components/team-section";
import { Face } from "@/components/ui";
import { listAgents } from "@/lib/agents/store";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { memberRoles } from "@/lib/members";
import { listPeople } from "@/lib/people";
import { requireAppContext } from "@/lib/session";
import { listTasks } from "@/lib/tasks";

import { AddPersonForm, PersonActions, ManagerSelect } from "./team-controls";

const STATUS_LABELS = {
  active: { label: "Joined", className: "text-ok" },
  invited: { label: "Invited", className: "text-warn" },
  not_invited: { label: "Not invited", className: "text-faint" },
} as const;

const SHOW = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
  { value: "agents", label: "Agents" },
] as const;

// Everyone the company works with: the people in its org chart and its
// agents, in one place. ?show= narrows it to one kind; ?new= opens an add form.
export default async function TeamPage({ searchParams }: PageProps<"/team">) {
  const { organization, person: me, isAdmin } = await requireAppContext();
  const params = await searchParams;
  const show = params.show === "people" || params.show === "agents" ? params.show : "all";
  const [people, agents, tasks, roles] = await Promise.all([
    listPeople(organization.id),
    listAgents(organization.id),
    listTasks(organization.id, { closedLimit: 0 }),
    memberRoles(organization.id).catch(() => new Map<string, { membershipId: string; role: "admin" | "member" }>()),
  ]);
  const roleOf = (workosUserId: string | null) => (workosUserId ? (roles.get(workosUserId)?.role ?? null) : null);
  const defined = agents.filter((a) => a.kind === "defined");
  const workers = agents.filter((a) => a.kind === "worker");
  const openTasksFor = (id: string) => tasks.filter((t) => t.members.some((m) => m.id === id));

  return (
    <>
      <PageHeader title="Team" count={people.length + defined.length}>
        <div className="mr-2 flex border border-line" role="tablist" aria-label="Show">
          {SHOW.map((option) => (
            <Link
              key={option.value}
              href={option.value === "all" ? "/team" : `/team?show=${option.value}`}
              role="tab"
              aria-selected={show === option.value}
              className={`px-2.5 py-1 text-[13px] ${show === option.value ? "bg-selected text-ink" : "text-muted hover:text-ink"}`}
            >
              {option.label}
            </Link>
          ))}
        </div>
      </PageHeader>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-12 px-4 py-6 sm:px-8 md:py-8">
          {show !== "agents" && (
            <TeamSection
              title="People"
              count={people.length}
              addLabel="Add person"
              startOpen={params.new === "person"}
              form={<AddPersonForm managers={people.map((p) => p.name)} />}
            >
              <div className="overflow-x-auto border border-line bg-raised">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="border-b border-line text-left">
                    <tr>
                      <th className="label px-3 py-2.5 font-normal">Name</th>
                      <th className="label px-3 py-2.5 font-normal">Role</th>
                      <th className="label px-3 py-2.5 font-normal">Reports to</th>
                      <th className="label px-3 py-2.5 font-normal">Status</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {people.map((person) => {
                      const status = STATUS_LABELS[person.status];
                      return (
                        <tr key={person.id} className="align-top">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <Face name={person.name} size={24} />
                              <div>
                                <div>
                                  {person.name}
                                  {person.id === me.id && <span className="text-muted"> (you)</span>}
                                  {roleOf(person.workosUserId) === "admin" && <span className="label ml-2 text-accent-ink">Admin</span>}
                                </div>
                                <div className="text-xs text-faint">
                                  {[person.email, person.phone].filter(Boolean).join(" · ") || "No contact details"}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">{person.role || <span className="text-faint">—</span>}</td>
                          <td className="px-3 py-2">
                            <ManagerSelect
                              key={person.managerName ?? ""}
                              personId={person.id}
                              value={person.managerName ?? ""}
                              options={people.filter((p) => p.id !== person.id).map((p) => p.name)}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <span className={`label whitespace-nowrap ${status.className}`}>{status.label}</span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <PersonActions
                              personId={person.id}
                              status={person.status}
                              hasEmail={Boolean(person.email)}
                              inviteUrl={person.inviteUrl}
                              canManage={isAdmin && person.id !== me.id}
                              role={roleOf(person.workosUserId)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </TeamSection>
          )}

          {show !== "people" && (
            <TeamSection
              title="Agents"
              count={defined.length + 1}
              addLabel="New agent"
              startOpen={params.new === "agent"}
              form={
                <div className="frame bg-raised p-6">
                  <AgentForm templates={AGENT_TEMPLATES} />
                </div>
              }
            >
              <ul className="divide-y divide-line-soft border border-line bg-raised">
                <li className="flex items-center gap-3 px-4 py-3">
                  <Face name="Chief of Staff" agent size={30} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px]">Chief of Staff</p>
                    <p className="truncate text-sm text-muted">Keeps the company profile, turns requests into tasks, staffs them.</p>
                  </div>
                </li>
                {defined.map((agent) => (
                  <li key={agent.id}>
                    <Link href={`/agents/${agent.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-hover">
                      <Face name={agent.name} agent size={30} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px]">
                          {agent.name}
                          {agent.status !== "active" && <span className="label ml-2 text-faint">{agent.status}</span>}
                        </p>
                        <p className="truncate text-sm text-muted">{agent.role || agent.description || "No role yet"}</p>
                      </div>
                      <span className="label text-faint">{openTasksFor(agent.id).length} open</span>
                    </Link>
                  </li>
                ))}
                {workers.map((agent) => {
                  const task = openTasksFor(agent.id)[0];
                  return (
                    <li key={agent.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                      <Face name={agent.name} agent size={30} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px]">
                          {agent.name} <span className="label ml-1 text-faint">worker</span>
                        </p>
                        <p className="truncate text-sm text-muted">{agent.role}</p>
                      </div>
                      {task && (
                        <Link
                          href={`/tasks/${task.number}`}
                          className="label min-w-0 basis-full truncate pl-[42px] hover:text-ink sm:max-w-[45%] sm:basis-auto sm:pl-0"
                        >
                          #{task.number} {task.title}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </TeamSection>
          )}
        </div>
      </div>
    </>
  );
}
