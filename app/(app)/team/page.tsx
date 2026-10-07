import ReactMarkdown from "react-markdown";

import { PageHeader } from "@/components/page-header";
import { Face } from "@/components/ui";

import { listPeople } from "@/lib/people";
import { renderOrgTree } from "@/lib/profile/markdown";
import { requireAppContext } from "@/lib/session";

import { AddPersonForm, PersonActions, ManagerSelect } from "./team-controls";

const STATUS_LABELS = {
  active: { label: "Joined", className: "text-ok" },
  invited: { label: "Invited", className: "text-warn" },
  not_invited: { label: "Not invited", className: "text-faint" },
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
    <>
    <PageHeader title="Team" count={people.length} />
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="grid max-w-6xl gap-8 px-8 py-6 lg:grid-cols-[1fr_300px]">
        <section className="min-w-0 space-y-6">
          <p className="text-sm text-muted">
            Everyone in {organization.name}&apos;s org chart. People don&apos;t need a login to be here; invite them when
            they should start using Mach.
          </p>

          <div className="overflow-x-auto border border-line bg-raised">
            <table className="w-full text-sm">
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
          <h2 className="label">Reporting lines</h2>
          <div className="prose prose-mach prose-sm max-w-none border border-line bg-raised p-4">
            <ReactMarkdown>{tree || "_No one yet._"}</ReactMarkdown>
          </div>
        </aside>
      </div>
    </div>
    </>
  );
}
