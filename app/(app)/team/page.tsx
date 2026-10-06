import ReactMarkdown from "react-markdown";

import { listPeople } from "@/lib/people";
import { renderOrgTree } from "@/lib/profile/markdown";
import { requireAppContext } from "@/lib/session";

import { AddPersonForm, PersonActions, ManagerSelect } from "./team-controls";

const STATUS_LABELS = {
  active: { label: "Joined", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  invited: { label: "Invited", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  not_invited: { label: "Not invited", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
} as const;

export default async function TeamPage() {
  const { organization, person: me, isAdmin } = await requireAppContext();
  const people = await listPeople(organization.id);
  const tree = renderOrgTree(
    people.map((p) => ({
      name: p.name,
      role: p.role,
      reportsTo: p.managerName ?? "",
      responsibilities: "",
      contact: "",
    })),
  );

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0 space-y-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Team</h1>
            <p className="text-sm text-zinc-500">
              Everyone in {organization.name}&apos;s org chart. People don&apos;t need a login to be here; invite them
              when they should start using Mach.
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Reports to</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {people.map((person) => {
                  const status = STATUS_LABELS[person.status];
                  return (
                    <tr key={person.id} className="align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {person.name}
                          {person.id === me.id && <span className="font-normal text-zinc-500"> (you)</span>}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {[person.email, person.phone].filter(Boolean).join(" · ") || "No contact details"}
                        </div>
                      </td>
                      <td className="px-3 py-2">{person.role || <span className="text-zinc-400">—</span>}</td>
                      <td className="px-3 py-2">
                        <ManagerSelect
                          key={person.managerName ?? ""}
                          personId={person.id}
                          value={person.managerName ?? ""}
                          options={people.filter((p) => p.id !== person.id).map((p) => p.name)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${status.className}`}>{status.label}</span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <PersonActions
                          personId={person.id}
                          status={person.status}
                          hasEmail={Boolean(person.email)}
                          inviteUrl={person.inviteUrl}
                          canManage={isAdmin && person.id !== me.id}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <AddPersonForm managers={people.map((p) => p.name)} />
        </section>

        <aside className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">Reporting lines</h2>
          <div className="prose prose-sm prose-zinc max-w-none rounded-lg border border-zinc-200 bg-white p-4 dark:prose-invert dark:border-zinc-800 dark:bg-zinc-900">
            <ReactMarkdown>{tree || "_No one yet._"}</ReactMarkdown>
          </div>
        </aside>
      </div>
    </main>
  );
}
