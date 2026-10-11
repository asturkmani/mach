import type { AgentContext } from "@/lib/agents/prompts";
import { approvalLabel, approvalsFor, spendItem, type Approval } from "@/lib/approvals";

// Gates in code (docs/agent-design.md): each tool says what it touches, and a
// change outside Mach1 runs only under an approval a person gave for exactly
// that content, unless a skill an admin pre-approved covers that one narrow
// kind of write. The check runs before the tool does anything, in the wrapper
// every task tool passes through (narrated() in lib/agents/runner.ts); the
// chat agent's tools get it too.

export type Effect =
  | { external: false }
  | { external: true; tool: "call_api" | "github_api" | "use_browser"; what: string; method?: string; path?: string; slug?: string };

const READS = new Set(["GET", "HEAD"]);

/** What a tool call touches: only changes outside Mach1 are gated. */
export function effectOf(tool: string, input: Record<string, unknown>): Effect {
  const method = String(input.method ?? "GET").toUpperCase();
  const path = String(input.path ?? "");
  if (tool === "call_api" && !READS.has(method)) {
    return { external: true, tool, method, path, slug: String(input.integration ?? ""), what: `${method} ${path} on ${input.integration}` };
  }
  if (tool === "github_api" && !READS.has(method)) return { external: true, tool, method, path, what: `${method} ${path} on GitHub` };
  if (tool === "use_browser" && input.changes === true) return { external: true, tool, what: "changes on a website" };
  return { external: false };
}

/**
 * Whether a pre-approval covers a write: "github:POST:/repos/*\/*\/pulls" (a
 * pattern, * one path part) or "api:<integration>:<METHOD>:<path prefix>".
 */
export function preApproves(rule: string, effect: Extract<Effect, { external: true }>): boolean {
  const [scope, ...rest] = rule.split(":");
  if (scope === "github" && effect.tool === "github_api") {
    const [method, pattern] = [rest[0], rest.slice(1).join(":")];
    if (method?.toUpperCase() !== effect.method) return false;
    const want = pattern.split("/");
    const got = (effect.path ?? "").split("?")[0].split("/");
    return want.length === got.length && want.every((part, i) => part === "*" ? got[i] !== "" : part === got[i]);
  }
  if (scope === "api" && effect.tool === "call_api") {
    const [slug, method, ...prefix] = rest;
    return slug === effect.slug && method?.toUpperCase() === effect.method && (effect.path ?? "").startsWith(prefix.join(":") || "/");
  }
  return false;
}

const refuse = (effect: Extract<Effect, { external: true }>, why: string) =>
  `Not done: ${effect.what} changes something outside Mach1, so it needs a person's approval of exactly this change. ${why}`;

/**
 * Checks a task run's tool call against the gates: null when it may go ahead,
 * else what to do instead. A write under an approval uses up its item.
 */
export async function checkGate(
  context: AgentContext,
  tool: string,
  input: Record<string, unknown>,
  preApproved: readonly string[] = [],
): Promise<string | null> {
  "use step";
  const effect = effectOf(tool, input);
  if (!effect.external) return null;
  if (preApproved.some((rule) => preApproves(rule, effect))) return null;
  if (!context.taskId) {
    return refuse(effect, "From chat, hand it to the Worker with spawn_worker: it asks for the approval with the exact changes, and makes them once it's given.");
  }
  const ref = String(input.approval ?? "").replace(/^A/i, "");
  if (!ref) return refuse(effect, "Call request_approval with the exact changes first (it ends your run), then call this again with approval and item.");
  const approvals = await approvalsFor(context.organizationId, context.taskId);
  const approval: Approval | undefined = approvals.find((a) => String(a.number) === ref && a.kind === "writes");
  if (!approval) return refuse(effect, `There's no approval A${ref} on this task. Ask for one with request_approval.`);
  if (approval.status !== "approved") return refuse(effect, `${approvalLabel(approval)} is ${approval.status === "pending" ? "still waiting on a person" : "declined"}.`);
  if (effect.tool === "use_browser") return null; // the browser agent checks each step against the approved list
  if (approval.fileHash) return null; // a file approved as a whole
  const item = Number(input.item);
  if (!Number.isInteger(item) || item < 1 || item > approval.items.length) {
    return refuse(effect, `Say which of ${approvalLabel(approval)}'s ${approval.items.length} items this is (item).`);
  }
  if (!(await spendItem(approval.id, item, tool, effect.what))) {
    return `Not done: item ${item} of ${approvalLabel(approval)} was already done. Each approved change is made once; check your ledger.`;
  }
  return null;
}
