import Link from "next/link";

import { NewAgent } from "@/components/new-agent";
import { PageHeader } from "@/components/page-header";
import { Face } from "@/components/ui";
import { listAgents } from "@/lib/agents/store";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { requireAppContext } from "@/lib/session";
import { listTasks } from "@/lib/tasks";

export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  const { organization } = await requireAppContext();
  const [agents, tasks] = await Promise.all([listAgents(organization.id), listTasks(organization.id, { closedLimit: 0 })]);
  const openTasksFor = (id: string) => tasks.filter((t) => t.members.some((m) => m.id === id));
  const defined = agents.filter((a) => a.kind === "defined");
  const workers = agents.filter((a) => a.kind === "worker");
  const startOpen = (await searchParams).new === "1";

  return (
    <>
      <PageHeader title="Agents" count={defined.length + workers.length} />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-4xl space-y-10">
          <p className="max-w-2xl text-[15px] text-muted">
            <span className="text-ink">Defined agents</span> have a standing profile and take on the same kind of work again
            and again. <span className="text-ink">Worker agents</span> are made for one task and archived when it closes.
            Agents on a task see all of it: the ask, the thread, the files and everyone on it.
          </p>

          <NewAgent templates={AGENT_TEMPLATES} startOpen={startOpen} />

          <section>
            <h2 className="label mb-3">Chief of Staff</h2>
            <div className="flex items-center gap-3 border border-line bg-raised px-4 py-3">
              <Face name="Chief of Staff" agent size={30} />
              <div>
                <p className="text-[15px]">Chief of Staff</p>
                <p className="text-sm text-muted">Keeps the company profile current, turns requests into tasks and puts the right people and agents on them.</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="label mb-3">Defined agents</h2>
            {defined.length === 0 ? (
              <p className="text-sm text-faint">None yet. Create one from a template with New defined agent, or ask the Chief of Staff.</p>
            ) : (
              <ul className="divide-y divide-line-soft border border-line bg-raised">
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
            )}
          </section>

          <section>
            <h2 className="label mb-3">Worker agents</h2>
            {workers.length === 0 ? (
              <p className="text-sm text-faint">None working. Add one to any task for a one-off job.</p>
            ) : (
              <ul className="divide-y divide-line-soft border border-line bg-raised">
                {workers.map((agent) => {
                  const task = openTasksFor(agent.id)[0];
                  return (
                    <li key={agent.id} className="flex items-center gap-3 px-4 py-3">
                      <Face name={agent.name} agent size={30} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px]">{agent.name}</p>
                        <p className="truncate text-sm text-muted">{agent.role}</p>
                      </div>
                      {task && (
                        <Link href={`/tasks/${task.number}`} className="label hover:text-ink">
                          #{task.number} {task.title.slice(0, 40)}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
