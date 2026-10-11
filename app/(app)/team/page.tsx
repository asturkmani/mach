import { BadgeCheck, Repeat } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { DataCell, DataRow, DataTable, PageBody, Section, Segmented } from "@/components/kit";
import { Face } from "@/components/ui";
import { memberRoles } from "@/lib/members";
import { listPeople } from "@/lib/people";
import { formatPhone } from "@/lib/phone-format";
import { requireAppContext } from "@/lib/session";
import { isRunning } from "@/lib/tasks";
import { timeIn } from "@/lib/agents/prompts";
import { listScheduledJobs } from "@/lib/work-overview";

import { AddPersonForm, EditableText, PersonActions, ManagerSelect } from "./team-controls";

// @map Team | Left menu → Team | The people the company works with (role, manager, contact details, whether they've joined or been invited, admin or member) and its scheduled jobs (?show=people for people only). Admins add and invite people here (?new=person opens the form) and remove them. How work is done lives in Skills, not in agents of the company's own.
const STATUS_LABELS = {
  active: { label: "Joined", className: "text-ok" },
  invited: { label: "Invited", className: "text-warn" },
  not_invited: { label: "Not invited", className: "text-faint" },
} as const;

const SHOW = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
] as const;

// The people the company works with, in its org chart, and the jobs that run
// on a schedule. ?show=people narrows it to people; ?new= opens an add form.
// Companies don't define agents: how their work is done lives in skills.
export default async function TeamPage({ searchParams }: PageProps<"/team">) {
  const { organization, person: me, isAdmin } = await requireAppContext();
  const params = await searchParams;
  const show = params.show === "people" ? "people" : "all";
  const [people, jobs, roles] = await Promise.all([
    listPeople(organization.id),
    listScheduledJobs(organization.id, { viewer: me.id }),
    memberRoles(organization.id).catch(() => new Map<string, { membershipId: string; role: "admin" | "member" }>()),
  ]);
  const roleOf = (workosUserId: string | null) => (workosUserId ? (roles.get(workosUserId)?.role ?? null) : null);

  return (
    <>
      <PageHeader title="Team" count={people.length}>
        <div className="mr-2">
          <Segmented
            label="Show"
            value={show}
            options={SHOW.map((o) => ({ ...o, href: o.value === "all" ? "/team" : `/team?show=${o.value}` }))}
          />
        </div>
      </PageHeader>
      <PageBody className="space-y-12">
          <Section
              title="People"
              count={people.length}
              addLabel="Add person"
              startOpen={params.new === "person"}
              form={<AddPersonForm managers={people.map((p) => p.name)} canInvite={isAdmin} />}
            >
              <DataTable columns={["Name", "Role", "Reports to", "Status", ""]}>
                    {people.map((person) => {
                      const status = STATUS_LABELS[person.status];
                      return (
                        <DataRow key={person.id}>
                          <DataCell main>
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
                          </DataCell>
                          <DataCell label="Role" className="md:max-w-72">
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
                          </DataCell>
                          <DataCell label="Reports to">
                            <ManagerSelect
                              key={person.managerName ?? ""}
                              personId={person.id}
                              value={person.managerName ?? ""}
                              options={people.filter((p) => p.id !== person.id).map((p) => p.name)}
                            />
                          </DataCell>
                          <DataCell label="Status">
                            <span className={`label whitespace-nowrap ${status.className}`}>{status.label}</span>
                          </DataCell>
                          <DataCell end>
                            <PersonActions
                              personId={person.id}
                              status={person.status}
                              hasEmail={Boolean(person.email)}
                              inviteUrl={person.inviteUrl}
                              canManage={isAdmin && person.id !== me.id}
                              role={roleOf(person.workosUserId)}
                            />
                          </DataCell>
                        </DataRow>
                      );
                    })}
              </DataTable>
            </Section>

          {show !== "people" && jobs.length > 0 && (
            <Section
              title="Scheduled jobs"
              count={jobs.length}
              description="Work that runs by itself on a schedule. Most replay a saved script without AI; each has an agent that steps in only when a run breaks."
            >
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
            </Section>
          )}
      </PageBody>
    </>
  );
}
