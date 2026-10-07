import "server-only";

import { listAgents, type Agent } from "@/lib/agents/store";
import { findMentions } from "@/lib/mentions";
import { listPeople, type Person } from "@/lib/people";
import { addMember, addMention, addMessage, type Task } from "@/lib/tasks";

// What an @-mention does: a mentioned person is added to the task (if they
// weren't on it) and it shows in their Needs you until they open it; a
// mentioned agent, when a person mentions it, is added so it can be woken.

export type MentionAuthor = { name: string; personId?: string; agentId?: string };

export async function recordMentions(
  organizationId: string,
  task: Task,
  text: string,
  by: MentionAuthor,
  { agents: includeAgents = false }: { agents?: boolean } = {},
): Promise<{ people: Person[]; agents: Agent[] }> {
  if (!text.includes("@")) return { people: [], agents: [] };
  const [people, agents] = await Promise.all([
    listPeople(organizationId),
    includeAgents ? listAgents(organizationId) : Promise.resolve([] as Agent[]),
  ]);
  const candidates = [
    ...people.map((p) => ({ id: p.id, name: p.name, person: p })),
    ...agents.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name, agent: a })),
  ];
  const mentioned = findMentions(text, candidates);
  const onTask = new Set(task.members.map((m) => m.id));
  const result = { people: [] as Person[], agents: [] as Agent[] };
  for (const m of mentioned) {
    if ("person" in m && m.person) {
      if (m.person.id === by.personId) continue;
      if (!onTask.has(m.person.id)) {
        await addMember(task.id, { personId: m.person.id });
        await addMessage(task.id, { author: by.name, personId: by.personId, agentId: by.agentId, kind: "event", body: `Added ${m.person.name}.` });
      }
      await addMention(task.id, m.person.id, by.name);
      result.people.push(m.person);
    } else if ("agent" in m && m.agent) {
      if (!onTask.has(m.agent.id)) {
        await addMember(task.id, { agentId: m.agent.id });
        await addMessage(task.id, { author: by.name, personId: by.personId, kind: "event", body: `Added ${m.agent.name}.` });
      }
      result.agents.push(m.agent);
    }
  }
  return result;
}
