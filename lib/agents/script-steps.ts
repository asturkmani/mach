import { firstSentence, type RunContext } from "@/lib/agents/prompts";
import { SKILLS, getSkill } from "@/lib/agents/skills";
import { WORKER_AGENT, findBuiltinAgent } from "@/lib/agents/store";
import type { ReplayResult } from "@/lib/agents/sandbox-steps";
import { companySkillsFor } from "@/lib/company-skills";
import { addMessage, agentsOn, claimRun, getTask, isRunning, updateTask } from "@/lib/tasks";

// A job's script child: one of a skill's scripts, run without a model
// (docs/agent-design.md). If it fails, the Worker on the child fixes it and
// finishes the work; the learner later proposes the fixed script.

export type ScriptPlan =
  | { type: "skip"; reason: string }
  | { type: "run"; context: RunContext; skill: string; scripts: Record<string, string>; path: string; args: string[]; label: string };

export type ScriptSpec = { skill: string; path: string; args?: string[] };

/** Checks the child can run, takes its lease, and finds the script. */
export async function beginScriptChild(organizationId: string, taskId: string): Promise<ScriptPlan> {
  "use step";
  const task = await getTask(organizationId, taskId);
  const spec = (task?.payload as { script?: ScriptSpec } | null)?.script;
  if (!task || !spec || task.status === "done" || task.status === "cancelled") return { type: "skip", reason: "Nothing to run." };
  if (isRunning(task)) return { type: "skip", reason: "A run is going." };
  const worker = agentsOn(task).find((a) => a.status === "active") ?? (await findBuiltinAgent(organizationId, WORKER_AGENT));
  if (!worker) return { type: "skip", reason: "No one to run it." };
  const skill = getSkill(spec.skill, [...SKILLS, ...(await companySkillsFor(organizationId, task.createdByPersonId))]);
  if (!(await claimRun(organizationId, task.id, worker.id, `Running ${spec.path}`))) return { type: "skip", reason: "A run is going." };
  return {
    type: "run",
    context: { organizationId, taskId: task.id, agentId: worker.id, agentName: worker.name, personId: task.createdByPersonId ?? undefined },
    skill: spec.skill,
    scripts: skill?.scripts ?? {},
    path: spec.path,
    args: spec.args ?? [],
    label: `${spec.skill}/${spec.path}`,
  };
}

/** The script worked: its result on the child, which is delivered. */
export async function reportScript(context: RunContext, result: Extract<ReplayResult, { ok: true }>, label: string): Promise<void> {
  "use step";
  const body = [
    `**Ran ${label}.** ${result.summary ?? "It finished."}`,
    result.attached.length ? `Attached ${result.attached.join(", ")}.` : "",
    result.drive.length ? `Saved to the drive: ${result.drive.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  await addMessage(context.taskId, { author: context.agentName, agentId: context.agentId, kind: "result", body });
  await updateTask(context.organizationId, context.taskId, { status: "review", summary: firstSentence(result.summary ?? `Ran ${label}.`), options: [] });
}

/** The script failed: the log on the thread, and the Worker fixes it and finishes the work. */
export async function scriptToWorker(context: RunContext, result: Extract<ReplayResult, { ok: false }>, label: string): Promise<void> {
  "use step";
  await addMessage(context.taskId, {
    author: "Mach1",
    kind: "update",
    body: `${label} failed. @${context.agentName}, its scripts are in /vercel/job/skills/: fix the script, run it, and report this part's result. Say what you fixed in your report.\n\n\`\`\`\n${result.log.slice(-3000)}\n\`\`\``,
  });
  await updateTask(context.organizationId, context.taskId, { status: "ready", options: [] });
}
