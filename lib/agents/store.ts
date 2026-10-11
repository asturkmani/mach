import "server-only";

import { modelOf } from "@/lib/agents/skills";
import { roleModel } from "@/lib/ai/lineup";
import { getDb } from "@/lib/db";
import type { CompanyModels } from "@/lib/orgs";

// The organization's agents, apart from the Chief of Staff. The Worker is
// Mach1's one agent for any piece of work: what makes a task research or
// coding is the skills it pins (docs/agent-design.md). Defined agents are the
// company's own, with a standing profile. Worker agents made for one task, and
// the built-in Developer and Researcher, are how it worked before: their open
// tasks carry on.

export type AgentKind = "defined" | "worker";
export type AgentStatus = "active" | "paused" | "archived";

export type Agent = {
  id: string;
  kind: AgentKind;
  name: string;
  role: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  createdAt: Date;
  /** A built-in agent Mach1 runs itself ("integrations"), or null for the company's own. */
  builtin: string | null;
  /** The model it runs on (an AI Gateway id), or null for the default for its kind (agentModel). */
  model: string | null;
};

type AgentRow = {
  id: string;
  kind: AgentKind;
  name: string;
  role: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  created_at: Date;
  builtin: string | null;
  model: string | null;
};

const COLUMNS = "id, kind, name, role, description, instructions, status, created_at, builtin, model";

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  role: r.role,
  description: r.description,
  instructions: r.instructions,
  status: r.status,
  createdAt: r.created_at,
  builtin: r.builtin,
  model: r.model,
});

export async function listAgents(
  organizationId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Agent[]> {
  const rows = await getDb().query<AgentRow>(
    `select ${COLUMNS} from agents where organization_id = $1 and ($2 or status <> 'archived')
     order by kind, lower(name)`,
    [organizationId, includeArchived],
  );
  return rows.map(toAgent);
}

export async function getAgent(organizationId: string, id: string): Promise<Agent | null> {
  const [row] = await getDb().query<AgentRow>(`select ${COLUMNS} from agents where organization_id = $1 and id = $2`, [
    organizationId,
    id,
  ]);
  return row ? toAgent(row) : null;
}

export async function findAgentByName(organizationId: string, name: string): Promise<Agent | null> {
  const [row] = await getDb().query<AgentRow>(
    `select ${COLUMNS} from agents where organization_id = $1 and lower(name) = lower($2) and status <> 'archived'`,
    [organizationId, name.trim()],
  );
  return row ? toAgent(row) : null;
}

export type AgentInput = {
  name: string;
  role?: string;
  description?: string;
  instructions?: string;
  /** An AI Gateway model id; empty for the default. */
  model?: string;
};

/** A model id as AI Gateway takes it ("provider/model"), or null for the default. */
function cleanModel(model: string | undefined): string | null {
  const id = model?.trim() ?? "";
  if (!id) return null;
  if (!/^[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(id)) throw new Error(`${id} isn't a model id. Use provider/model, e.g. anthropic/claude-sonnet-4.5.`);
  return id;
}

/**
 * The model an agent runs on: its own, else the company's default for
 * agents, else Mach1's for the work (the role of the first skill that names
 * one, e.g. coding-in-github runs on the coder; lib/ai/lineup.ts).
 */
export function agentModel(agent: Pick<Agent, "model" | "builtin">, company: CompanyModels = {}, skills: readonly string[] = []): string {
  // An agent's own playbook decides first: the Coordinator plans on the planner even on a coding job.
  const role = modelOf([...builtinSkills(agent), ...skills]);
  return agent.model || company.agents || roleModel(role ?? "worker");
}

export async function createAgent(organizationId: string, input: AgentInput & { kind?: AgentKind }): Promise<Agent> {
  const name = input.name.trim();
  if (!name) throw new Error("An agent needs a name.");
  if (await findAgentByName(organizationId, name)) throw new Error(`There is already an agent called ${name}.`);
  const [row] = await getDb().query<AgentRow>(
    `insert into agents (organization_id, kind, name, role, description, instructions, model)
     values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
    [
      organizationId,
      input.kind ?? "defined",
      name,
      input.role?.trim() ?? "",
      input.description?.trim() ?? "",
      input.instructions?.trim() ?? "",
      cleanModel(input.model),
    ],
  );
  return toAgent(row);
}

export const WORKER_AGENT = "worker";
export const COORDINATOR_AGENT = "coordinator";
export const INTEGRATIONS_AGENT = "integrations";
export const CODING_AGENT = "coding";
export const RESEARCH_AGENT = "research";

/**
 * The skills Mach1's older built-in agents always read: the Developer was the
 * coding skill, the Researcher the research skill. Their open tasks carry on
 * as the same work.
 */
export function builtinSkills(agent: Pick<Agent, "builtin">): string[] {
  switch (agent.builtin) {
    case CODING_AGENT:
      return ["coding-in-github"];
    case RESEARCH_AGENT:
      return ["research"];
    case INTEGRATIONS_AGENT:
      return ["connecting-integrations"];
    case COORDINATOR_AGENT:
      return ["coordinating"];
    default:
      return [];
  }
}

/** Mach1's Worker: the agent for any piece of work, made the first time it's needed. */
export function workerAgent(organizationId: string): Promise<Agent> {
  return builtinAgent(organizationId, WORKER_AGENT, {
    name: "Worker",
    role: "Does the work, with the skills each task needs",
    description:
      "Mach1's agent for any piece of work: research and briefs, analysis and models, code changes in GitHub, data pulls and pipelines, documents and decks, and work on websites. Each task says which skills it needs, and it reads them before it starts.",
  });
}

/** Mach1's Coordinator: the agent of a job, made the first time one starts. */
export function coordinatorAgent(organizationId: string): Promise<Agent> {
  return builtinAgent(organizationId, COORDINATOR_AGENT, {
    name: "Coordinator",
    role: "Plans and runs jobs, and reports once",
    description:
      "Mach1's agent for jobs: work with several deliverables that depend on each other, people or approvals in it, or in-depth research. It plans the job, starts the work as child tasks (the Worker with the skills each part needs, or people), checks what comes back, and reports once.",
  });
}

/** One of the agents Mach1 runs itself, if the company has it yet (not archived). */
export async function findBuiltinAgent(organizationId: string, builtin: string): Promise<Agent | null> {
  const [row] = await getDb().query<AgentRow>(
    `select ${COLUMNS} from agents where organization_id = $1 and builtin = $2 and status <> 'archived' order by created_at limit 1`,
    [organizationId, builtin],
  );
  return row ? toAgent(row) : null;
}

/**
 * One of the agents Mach1 runs itself, made the first time it's needed (or
 * brought back if it was paused or archived). People can rename it or add
 * instructions; its playbook comes with Mach1.
 */
async function builtinAgent(organizationId: string, builtin: string, profile: AgentInput & { name: string }): Promise<Agent> {
  const found = await findBuiltinAgent(organizationId, builtin);
  if (found) {
    if (found.status !== "active") await getDb().query("update agents set status = 'active', updated_at = now() where id = $1", [found.id]);
    return { ...found, status: "active" };
  }
  let name = profile.name;
  for (let n = 2; await findAgentByName(organizationId, name); n++) name = `${profile.name} ${n}`;
  // Made with its builtin in the same insert: two runs needing it at once (a coordinator starting
  // children in parallel) can't make two. The one that loses finds the other's.
  const [row] = await getDb().query<AgentRow>(
    `insert into agents (organization_id, kind, name, role, description, instructions, builtin)
     values ($1, 'defined', $2, $3, $4, '', $5) on conflict do nothing returning ${COLUMNS}`,
    [organizationId, name, profile.role?.trim() ?? "", profile.description?.trim() ?? "", builtin],
  );
  if (row) return toAgent(row);
  const made = await findBuiltinAgent(organizationId, builtin);
  if (made) return made;
  throw new Error(`Couldn't make the ${profile.name} agent: the name ${name} was just taken.`);
}

export async function updateAgent(
  organizationId: string,
  id: string,
  patch: Partial<AgentInput> & { status?: AgentStatus },
): Promise<Agent | null> {
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new Error("An agent needs a name.");
  if (name) {
    const clash = await findAgentByName(organizationId, name);
    if (clash && clash.id !== id) throw new Error(`There is already an agent called ${name}.`);
  }
  const [row] = await getDb().query<AgentRow>(
    `update agents set
       name = coalesce($3, name),
       role = coalesce($4, role),
       description = coalesce($5, description),
       instructions = coalesce($6, instructions),
       status = coalesce($7, status),
       model = case when $8 then $9 else model end,
       updated_at = now()
     where organization_id = $1 and id = $2 returning ${COLUMNS}`,
    [
      organizationId,
      id,
      name ?? null,
      patch.role?.trim() ?? null,
      patch.description?.trim() ?? null,
      patch.instructions?.trim() ?? null,
      patch.status ?? null,
      patch.model !== undefined,
      cleanModel(patch.model),
    ],
  );
  return row ? toAgent(row) : null;
}
