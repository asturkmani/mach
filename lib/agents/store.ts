import "server-only";

import { getDb } from "@/lib/db";
import type { CompanyModels } from "@/lib/orgs";

// The organization's agents, apart from the Chief of Staff. Defined agents have
// a standing profile and get similar work again and again; worker agents are
// made for a single task and archived when it closes.

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
 * agents, else Mach1's default for its kind (the Developer:
 * CODING_AGENT_MODEL, the Researcher: RESEARCH_AGENT_MODEL), else
 * AGENT_MODEL, else the Chief of Staff's. Empty when none is set.
 */
export function agentModel(agent: Pick<Agent, "model" | "builtin">, company: CompanyModels = {}): string {
  return (
    agent.model ||
    company.agents ||
    (agent.builtin === CODING_AGENT ? process.env.CODING_AGENT_MODEL : "") ||
    (agent.builtin === RESEARCH_AGENT ? process.env.RESEARCH_AGENT_MODEL : "") ||
    process.env.AGENT_MODEL ||
    process.env.CHIEF_OF_STAFF_MODEL ||
    ""
  );
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

export const INTEGRATIONS_AGENT = "integrations";
export const CODING_AGENT = "coding";
export const RESEARCH_AGENT = "research";

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
  const agent = await createAgent(organizationId, { ...profile, name });
  await getDb().query("update agents set builtin = $2 where id = $1", [agent.id, builtin]);
  return { ...agent, builtin };
}

/** The company's Integrations agent: it connects the company's systems, each on its own task. */
export function integrationsAgent(organizationId: string): Promise<Agent> {
  return builtinAgent(organizationId, INTEGRATIONS_AGENT, {
    name: "Integrations",
    role: "Connecting the company's systems",
    description:
      "Connects the company's other systems (banking, portfolio, accounting and other platforms) so every agent can use them: works out what's possible, does the research, sets up the connection and doesn't stop until it works.",
  });
}

/**
 * The company's Developer agent, for code changes people ask for: it works in
 * their GitHub repositories, as the person who asked (their own GitHub, never
 * anyone else's). Its playbook is the coding-in-github skill.
 */
export function codingAgent(organizationId: string): Promise<Agent> {
  return builtinAgent(organizationId, CODING_AGENT, {
    name: "Developer",
    role: "Changes code in GitHub repositories",
    description:
      "Makes code changes people ask for in their GitHub repositories, as the person who asked: clones the repository, works on a branch, runs its checks, pushes and opens a pull request, then reports what changed with the link. Merges only when told to.",
    instructions: "Load the coding-in-github skill before you start, and follow it.",
  });
}

/**
 * The company's Researcher: investment, market, company and people research
 * of the kind a family office does, from the web, market data, X and Reddit,
 * starting with the sources each person saved as high signal. Its playbook is
 * the research skill.
 */
export function researchAgent(organizationId: string): Promise<Agent> {
  return builtinAgent(organizationId, RESEARCH_AGENT, {
    name: "Researcher",
    role: "Research and insight",
    description:
      "Researches companies, markets, sectors, managers and people for investment decisions: plans the questions, investigates them in parallel across the web, filings, market data, X and Reddit (starting with the sources people saved as high signal), and delivers a sourced brief that leads with the insight and says what would change it.",
    instructions: "Load the research skill before you start, and follow it.",
  });
}

/** A throwaway agent for one task, named after its role ("Research worker", then "Research worker 2"). */
export async function createWorker(organizationId: string, role = ""): Promise<Agent> {
  const base = role.trim() ? `${role.trim().replace(/\s+worker$/i, "")} worker` : "Worker";
  const [{ taken }] = await getDb().query<{ taken: string[] }>(
    `select coalesce(array_agg(lower(name)), '{}') as taken from agents
     where organization_id = $1 and status <> 'archived' and lower(name) like lower($2) || '%'`,
    [organizationId, base],
  );
  let name = base;
  for (let n = 2; taken.includes(name.toLowerCase()); n++) name = `${base} ${n}`;
  return createAgent(organizationId, {
    kind: "worker",
    name,
    role: role.trim() || "General worker",
    description: "A general worker made for one task. It does that task and nothing else.",
  });
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
