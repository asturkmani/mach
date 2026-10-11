import type { Role } from "@/lib/ai/lineup";
import { modelOf, SKILLS, type Skill } from "@/lib/agents/skills";
import type { Task } from "@/lib/tasks";

// What a job's plan is likely to cost, worked out in code as its children
// start (docs/agent-design.md, Gates in code). Above the company's limit, a
// child only starts under a cost approval a person gave for at least that
// much. Rough dollars for one run of each kind: not a bill, only enough to
// stop a big plan starting without anyone agreeing to it.

/** One run on each role's model, in dollars. */
export const RUN_COST: Record<Role, number> = { chat: 0.02, worker: 0.4, coder: 1.5, browser: 1, planner: 0.5, background: 0.01, learner: 0.5 };

/** A script child runs without a model: its sandbox time. */
export const SCRIPT_COST = 0.05;

type Child = Pick<Task, "assigneeKind" | "skills" | "batch" | "status">;

/** One child's run: a person's is free, a script's is its sandbox, the Worker's is its model's, plus the browser agent when it uses it. */
export function childCost(child: Pick<Child, "assigneeKind" | "skills">, catalogue: readonly Skill[] = SKILLS): number {
  if (child.assigneeKind === "person") return 0;
  if (child.assigneeKind === "script") return SCRIPT_COST;
  const browser = child.skills.includes("using-the-browser") ? RUN_COST.browser : 0;
  return RUN_COST[modelOf(child.skills, catalogue) ?? "worker"] + browser;
}

/**
 * This round's estimate: its children (working or delivered, not cancelled;
 * earlier rounds' are done) and the coordinator's own runs, one per batch and
 * one to report.
 */
export function jobEstimate(children: readonly Child[], catalogue: readonly Skill[] = SKILLS): number {
  const round = children.filter((c) => c.status !== "done" && c.status !== "cancelled");
  const batches = new Set(round.map((c) => c.batch)).size;
  const total = round.reduce((sum, c) => sum + childCost(c, catalogue), 0) + RUN_COST.planner * (batches + 1);
  return Math.round(total * 100) / 100;
}

export const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The figures, for the coordinator's brief when the company has a limit. */
export function costRates(limit: number, estimate: number): string {
  return `The company asks for approval before a job's round is estimated above ${dollars(limit)}. Rough figures: a Worker child ${dollars(RUN_COST.worker)} (${dollars(RUN_COST.coder)} with coding-in-github, ${dollars(RUN_COST.browser)} more with using-the-browser), a script ${dollars(SCRIPT_COST)}, a person's child nothing, and each of your own runs ${dollars(RUN_COST.planner)}. This round so far: about ${dollars(estimate)}. If your plan goes above the limit, add it up and ask once for the whole plan with request_approval (kind cost, estimate_usd) before starting it.`;
}
