import { BadgeCheck, Repeat } from "lucide-react";
import Link from "next/link";

import { AgentForm } from "@/components/agent-form";
import { PageHeader } from "@/components/page-header";
import { TeamSection } from "@/components/team-section";
import { Face } from "@/components/ui";
import { listAgents } from "@/lib/agents/store";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { memberRoles } from "@/lib/members";
import { listPeople } from "@/lib/people";
import { formatPhone } from "@/lib/phone-format";
import { requireAppContext } from "@/lib/session";
import { isRunning, listTasks } from "@/lib/tasks";
import { timeIn } from "@/lib/agents/prompts";
import { listScheduledJobs } from "@/lib/work-overview";

import { AddPersonForm, EditableText, PersonActions, ManagerSelect } from "./team-controls";

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
  const [people, agents, tasks, jobs, roles] = await Promise.all([
    listPeople(organization.id),
    listAgents(organization.id),
    listTasks(organization.id, { closedLimit: 0 }),
    listScheduledJobs(organization.id),
    memberRoles(organization.id).catch(() => new Map<string, { membershipId: string; role: "admin" | "member" }>()),
  ]);
  const roleOf = (workosUserId: string | null) => (workosUserId ? (roles.get(workosUserId)?.role ?? null) : null);
  const defined = agents.filter((a) => a.kind === "defined");
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
              form={<AddPersonForm managers={people.map((p) => p.name)} canInvite={isAdmin} />}
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
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-baseline gap-x-1">
                                  <EditableText personId={person.id} field="name" value={person.name} label="Name" placeholder="Name" />
                                  {person.id === me.id && <span className="text-muted">(you)</span>}
                                  {roleOf(person.workosUserId) === "admin" && <span className="label ml-1 text-accent-ink">Admin</span>}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
                                  <EditableText
                                    personId={person.id}
                                    field="email"
                                    value={person.email ?? ""}
                                    label="Email"
                                    placeholder="Add email"
                                    locked={person.workosUserId ? `The address ${person.name} signs in with. It changes only with their sign-in.` : undefined}
                                    className="text-xs"
                                  />
                                  <span>·</span>
                                  <span className="inline-flex items-center gap-1">
                                    <EditableText
                                      personId={person.id}
                                      field="phone"
                                      value={person.whatsapp ? formatPhone(person.whatsapp) : (person.phone ?? "")}
                                      label="Phone"
                                      placeholder="Add phone"
                                      locked={
                                        person.whatsapp
                                          ? `${person.name}'s linked WhatsApp: they proved it's theirs, so it reaches the Chief of Staff as them. They change it by linking another number.`
                                          : undefined
                                      }
                                      className="text-xs"
                                    />
                                    {person.whatsapp && <BadgeCheck size={12} className="text-ok" aria-label="Verified WhatsApp" />}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="max-w-72 px-3 py-2.5">
                            <EditableText personId={person.id} field="role" value={person.role} label="Role" placeholder="Add role" />
                            <EditableText
                              personId={person.id}
                              field="responsibilities"
                              value={person.responsibilities}
                              label="Responsibilities"
                              placeholder="Add responsibilities"
                              className="text-xs text-muted"
                              multiline
                            />
                          </td>
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
              </ul>
            </TeamSection>
          )}

          {show !== "people" && jobs.length > 0 && (
            <section>
              <div className="mb-3">
                <h2 className="label">
                  Scheduled jobs <span className="text-faint">{jobs.length}</span>
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Work that runs by itself on a schedule. Most replay a saved script without AI; each has an agent that steps in only
                  when a run breaks.
                </p>
              </div>
              <ul className="divide-y divide-line-soft border border-line bg-raised">
                {jobs.map(({ task, schedule, page }) => {
                  const fixer = task.members.find((m) => m.type === "agent");
                  const running = isRunning(task);
                  const trouble = !running && (task.status === "waiting" || task.status === "review");
                  return (
                    <li key={task.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                      <Repeat size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <Link href={`/tasks/${task.number}`} className="text-[15px] hover:underline">
                          {task.title}
                        </Link>
                        <p className="text-sm text-muted">
                          {schedule.paused ? "Paused" : schedule.description}
                          {!schedule.paused && schedule.nextRunAt && <> · next {timeIn(schedule.nextRunAt, schedule.timezone)}</>}
                          {schedule.lastRunAt && <> · last ran {timeIn(schedule.lastRunAt, schedule.timezone)}</>}
                        </p>
                        <p className="text-xs text-faint">
                          {page && (
                            <>
                              Keeps the{" "}
                              <Link href={`/pages/${page.slug}`} className="underline underline-offset-2 hover:text-ink">
                                {page.title}
                              </Link>{" "}
                              page fresh ·{" "}
                            </>
                          )}
                          {schedule.mode === "script" ? "Replays its script" : "Its agent does it each time"}
                          {fixer && <> · {schedule.mode === "script" ? `${fixer.name} fixes it if it breaks` : `by ${fixer.name}`}</>}
                        </p>
                      </div>
                      <span className={`label shrink-0 ${trouble ? "text-danger" : running ? "text-accent-ink" : "text-ok"}`}>
                        {running ? "Running" : trouble ? "Needs you" : schedule.paused ? "Paused" : "OK"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
