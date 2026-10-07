import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { AgentForm, AgentStatusControl } from "@/components/agent-form";
import { Face, When } from "@/components/ui";
import { getAgent } from "@/lib/agents/store";
import { requireAppContext } from "@/lib/session";
import { STATUS_WORDS } from "@/lib/task-words";
import { listAgentTasks } from "@/lib/tasks";

export default async function AgentPage({ params }: PageProps<"/agents/[id]">) {
  const { organization } = await requireAppContext();
  const { id } = await params;
  const agent = /^[0-9a-f-]{36}$/i.test(id) ? await getAgent(organization.id, id) : null;
  if (!agent) notFound();
  const tasks = await listAgentTasks(organization.id, agent.id);

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b border-line px-8 pb-5 pt-7">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/agents" className="text-muted hover:text-ink" title="Agents">
            <ArrowLeft size={16} />
          </Link>
          <Face name={agent.name} agent size={32} />
          <div className="min-w-0">
            <h1 className="truncate text-[22px] tracking-tight">{agent.name}</h1>
            <p className="label">
              {agent.kind === "worker" ? "Worker agent" : "Defined agent"} · {agent.status}
            </p>
          </div>
        </div>
        <AgentStatusControl agentId={agent.id} status={agent.status} />
      </header>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="grid max-w-5xl gap-10 lg:grid-cols-[1fr_300px]">
          <section>
            <h2 className="label mb-4">Profile</h2>
            <AgentForm
              agentId={agent.id}
              initial={{ name: agent.name, role: agent.role, description: agent.description, instructions: agent.instructions }}
            />
          </section>
          <section>
            <h2 className="label mb-4">Tasks</h2>
            {tasks.length === 0 ? (
              <p className="text-sm text-faint">Not on any tasks yet.</p>
            ) : (
              <ul className="space-y-2">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <Link href={`/tasks/${task.number}`} className="block border border-line bg-raised px-3 py-2 hover:border-muted">
                      <p className="label mb-0.5 flex justify-between">
                        <span>
                          #{task.number} · {STATUS_WORDS[task.status]}
                        </span>
                        <When date={new Date(task.updatedAt).toISOString()} />
                      </p>
                      <p className="text-sm">{task.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
