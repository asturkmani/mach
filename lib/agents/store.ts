import "server-only";

import { getDb } from "@/lib/db";

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
};

const COLUMNS = "id, kind, name, role, description, instructions, status, created_at";

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  role: r.role,
  description: r.description,
  instructions: r.instructions,
  status: r.status,
  createdAt: r.created_at,
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

export type AgentInput = { name: string; role?: string; description?: string; instructions?: string };

export async function createAgent(organizationId: string, input: AgentInput & { kind?: AgentKind }): Promise<Agent> {
  const name = input.name.trim();
  if (!name) throw new Error("An agent needs a name.");
  if (await findAgentByName(organizationId, name)) throw new Error(`There is already an agent called ${name}.`);
  const [row] = await getDb().query<AgentRow>(
    `insert into agents (organization_id, kind, name, role, description, instructions)
     values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [
      organizationId,
      input.kind ?? "defined",
      name,
      input.role?.trim() ?? "",
      input.description?.trim() ?? "",
      input.instructions?.trim() ?? "",
    ],
  );
  return toAgent(row);
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
    ],
  );
  return row ? toAgent(row) : null;
}
