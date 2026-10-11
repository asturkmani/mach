import { getDb } from "@/lib/db";

// Gates in code (docs/agent-design.md). A skill is text the model reads, so it
// can only ask for things; these hold even when a model ignores its
// instructions. A change outside Mach1 needs an approval a person gave for
// exactly that content (a numbered list, or a file), and each approved item is
// used once, recorded in a ledger, so a retry carries on instead of repeating.
// A job's children work under the job's approvals.

export type ApprovalKind = "writes" | "cost";

export type Approval = {
  id: string;
  taskId: string;
  number: number;
  kind: ApprovalKind;
  what: string;
  items: string[];
  fileName: string | null;
  fileHash: string | null;
  estimate: number | null;
  status: "pending" | "approved" | "declined";
  approvedBy: string | null;
  /** Items already used, by number (1-based). */
  used: number[];
};

type Row = {
  id: string;
  task_id: string;
  number: number;
  kind: ApprovalKind;
  what: string;
  items: string[];
  file_name: string | null;
  file_hash: string | null;
  estimate: number | null;
  status: Approval["status"];
  approved_by: string | null;
  used: number[] | null;
};

const SELECT = `select a.id, a.task_id, a.number, a.kind, a.what, a.items, a.file_name, a.file_hash, a.estimate, a.status, a.approved_by,
  array(select u.item from approval_uses u where u.approval_id = a.id order by u.item) as used from approvals a`;

const toApproval = (r: Row): Approval => ({
  id: r.id,
  taskId: r.task_id,
  number: r.number,
  kind: r.kind,
  what: r.what,
  items: r.items,
  fileName: r.file_name,
  fileHash: r.file_hash,
  estimate: r.estimate,
  status: r.status,
  approvedBy: r.approved_by,
  used: r.used ?? [],
});

/** Asks for an approval on a task: pending until a person on it approves. */
export async function requestApproval(
  organizationId: string,
  taskId: string,
  input: { kind?: ApprovalKind; what: string; items?: string[]; fileName?: string; fileHash?: string; estimate?: number; by: string },
): Promise<Approval> {
  const [row] = await getDb().query<Row>(
    `insert into approvals (organization_id, task_id, number, kind, what, items, file_name, file_hash, estimate, requested_by)
     values ($1, $2, (select coalesce(max(number), 0) + 1 from approvals where task_id = $2), $3, $4, $5::jsonb, $6, $7, $8, $9)
     returning id, task_id, number, kind, what, items, file_name, file_hash, estimate, status, approved_by, '{}'::int[] as used`,
    [
      organizationId,
      taskId,
      input.kind ?? "writes",
      input.what.trim(),
      JSON.stringify(input.items ?? []),
      input.fileName ?? null,
      input.fileHash ?? null,
      input.estimate ?? null,
      input.by,
    ],
  );
  return toApproval(row);
}

/** A task's approvals, and its job's (a child works under them), newest first. */
export async function approvalsFor(organizationId: string, taskId: string): Promise<Approval[]> {
  const rows = await getDb().query<Row>(
    `${SELECT} where a.organization_id = $1
       and a.task_id in (select id from tasks where id = $2 union select parent_task_id from tasks where id = $2 and parent_task_id is not null)
     order by a.created_at desc`,
    [organizationId, taskId],
  );
  return rows.map(toApproval);
}

/** The approval waiting on a task's people, if there is one. */
export async function pendingApproval(organizationId: string, taskId: string): Promise<Approval | null> {
  const [row] = await getDb().query<Row>(`${SELECT} where a.organization_id = $1 and a.task_id = $2 and a.status = 'pending' order by a.number desc limit 1`, [
    organizationId,
    taskId,
  ]);
  return row ? toApproval(row) : null;
}

export async function decideApproval(approvalId: string, decision: "approved" | "declined", by: { name: string; personId?: string }): Promise<void> {
  await getDb().query(
    `update approvals set status = $2, approved_by = $3, approved_by_person_id = $4, approved_at = now() where id = $1 and status = 'pending'`,
    [approvalId, decision, by.name, by.personId ?? null],
  );
}

/** Uses one approved item for a write, once: false if it was already used. */
export async function spendItem(approvalId: string, item: number, tool: string, detail: string): Promise<boolean> {
  const rows = await getDb().query(
    "insert into approval_uses (approval_id, item, tool, detail) values ($1, $2, $3, $4) on conflict do nothing returning item",
    [approvalId, item, tool, detail.slice(0, 500)],
  );
  return rows.length > 0;
}

/** Approved writes with items not yet used, for the task (or its job): what a run's scripts may still do. */
export async function openWrites(organizationId: string, taskId: string): Promise<Approval[]> {
  return (await approvalsFor(organizationId, taskId)).filter(
    (a) => a.kind === "writes" && a.status === "approved" && (a.fileHash !== null || a.used.length < a.items.length),
  );
}

export const approvalLabel = (a: Pick<Approval, "number">) => `A${a.number}`;
