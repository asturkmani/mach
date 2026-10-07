import { contentTypeFor, isText, readTaskFiles, saveVersion } from "@/lib/files";
import { versionPreview } from "@/lib/previews";
import type { RunContext } from "@/lib/agents/prompts";
import { JOB_DIR, sandboxes, sandboxNameFor, type JobSandbox } from "@/lib/sandbox";
import { getTask, saveMemory, setSandboxName } from "@/lib/tasks";

// The sandbox tools an agent uses on a job, each a durable workflow step. The
// job's sandbox is created on first use, seeded with the job's files and
// notes, and stopped (not deleted) at the end of the run.

/** A single command may run this long; longer work is split into steps. */
export const COMMAND_TIMEOUT_MS = 240_000;

const OUTPUT_LIMIT = 6000;
const clip = (text: string, max = OUTPUT_LIMIT) =>
  text.length > max ? `${text.slice(0, max / 2)}\n[…${text.length - max} characters cut…]\n${text.slice(-max / 2)}` : text;

const SAFE_NAME = /^[\w][\w.-]{0,79}$/;
const INTERPRETERS = { python: "python3", node: "node", bash: "bash" } as const;

/** Resolves a path inside the job folder; anything outside it is refused. */
export function jobPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^\/vercel\/job\/?/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("Paths must stay inside the job folder.");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("Give a file path inside the job folder.");
  return `${JOB_DIR}/${parts.join("/")}`;
}

/** Files that belong at the top of the job folder rather than under code/. */
const ROOT_FILES = /^(run\.sh|config\.(json|ya?ml|toml)|requirements\.txt)$/i;

async function seed(context: RunContext, sandbox: JobSandbox): Promise<void> {
  await sandbox.run("mkdir", ["-p", `${JOB_DIR}/code`, `${JOB_DIR}/inputs`, `${JOB_DIR}/outputs`]);
  const task = await getTask(context.organizationId, context.taskId);
  const files = await readTaskFiles(context.organizationId, context.taskId);
  await sandbox.writeFiles([
    { path: `${JOB_DIR}/NOTES.md`, content: Buffer.from(task?.memory || "# Job notes\n") },
    ...files.map((f) => ({
      path:
        f.kind === "code"
          ? `${JOB_DIR}/${ROOT_FILES.test(f.name) ? "" : "code/"}${f.name}`
          : `${JOB_DIR}/${f.role === "input" ? "inputs" : "outputs"}/${f.name}`,
      content: f.bytes,
    })),
  ]);
}

async function open(context: RunContext): Promise<JobSandbox> {
  const name = sandboxNameFor(context.taskId);
  const sandbox = await sandboxes().open(name, (created) => seed(context, created));
  await setSandboxName(context.taskId, name);
  return sandbox;
}

async function changedOutputs(sandbox: JobSandbox): Promise<string> {
  const found = await sandbox.run("bash", [
    "-c",
    `cd ${JOB_DIR} && find outputs -type f -newer .mark -printf '%P (%s bytes)\\n' 2>/dev/null | head -50`,
  ]);
  return found.stdout.trim().split("\n").filter(Boolean).join(", ");
}

export async function runCode(
  context: RunContext,
  input: { filename: string; language: keyof typeof INTERPRETERS; code: string },
): Promise<string> {
  "use step";
  if (!SAFE_NAME.test(input.filename)) return "Use a simple file name like simulate.py.";
  const sandbox = await open(context);
  const path = `${JOB_DIR}/code/${input.filename}`;
  await sandbox.writeFiles([{ path, content: Buffer.from(input.code) }]);
  await sandbox.run("touch", [`${JOB_DIR}/.mark`]);
  const result = await sandbox.run(INTERPRETERS[input.language], [path], { cwd: JOB_DIR, timeoutMs: COMMAND_TIMEOUT_MS });
  const changed = await changedOutputs(sandbox);
  const log = [`exit code ${result.exitCode}`, result.stdout && `stdout:\n${clip(result.stdout)}`, result.stderr && `stderr:\n${clip(result.stderr)}`]
    .filter(Boolean)
    .join("\n");
  // Every script that runs is kept in the library as code, with the output of its latest run.
  await saveVersion(context.organizationId, {
    name: input.filename,
    kind: "code",
    bytes: Buffer.from(input.code),
    taskId: context.taskId,
    agentId: context.agentId,
    note: clip(log, 4000),
  });
  const timedOut = result.exitCode === 137 || result.exitCode === -1;
  return `${log}${changed ? `\nnew or changed in outputs/: ${changed}` : ""}${
    timedOut ? `\nThe script may have hit the ${COMMAND_TIMEOUT_MS / 1000}s limit; split the work into smaller steps.` : ""
  }`;
}

export async function runShell(context: RunContext, input: { command: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const result = await sandbox.run("bash", ["-lc", input.command], { cwd: JOB_DIR, timeoutMs: COMMAND_TIMEOUT_MS });
  return [`exit code ${result.exitCode}`, result.stdout && `stdout:\n${clip(result.stdout)}`, result.stderr && `stderr:\n${clip(result.stderr)}`]
    .filter(Boolean)
    .join("\n");
}

export async function readSandboxFile(context: RunContext, input: { path: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const bytes = await sandbox.readFile(jobPath(input.path));
  if (!bytes) return `${input.path} doesn't exist.`;
  if (!isText(contentTypeFor(input.path)) || bytes.includes(0)) {
    return `${input.path} is a binary file (${bytes.length} bytes). Read it with code instead.`;
  }
  return clip(bytes.toString("utf8"), 20_000);
}

export async function writeSandboxFile(context: RunContext, input: { path: string; content: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const path = jobPath(input.path);
  await sandbox.run("mkdir", ["-p", path.slice(0, path.lastIndexOf("/"))]);
  await sandbox.writeFiles([{ path, content: Buffer.from(input.content) }]);
  return `Wrote ${path}.`;
}

export async function listSandboxFiles(context: RunContext): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const result = await sandbox.run("bash", [
    "-c",
    `cd ${JOB_DIR} && find . -path ./.mark -prune -o -type f -printf '%P\\t%s bytes\\t%TY-%Tm-%Td %TH:%TM\\n' | sort | head -200`,
  ]);
  return result.stdout.trim() || "The job folder is empty.";
}

export async function attachSandboxFile(context: RunContext, input: { path: string; note?: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const path = jobPath(input.path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!SAFE_NAME.test(name)) return "Give the file a simple name like portfolio-model.xlsx before attaching it.";
  if (/\.xlsx$/i.test(name)) {
    // Store computed values in the workbook so previews and readers see numbers, not just formulas.
    await sandbox.run("bash", ["-c", `command -v recalc >/dev/null && recalc "${path}" || true`], { timeoutMs: 120_000 });
  }
  const bytes = await sandbox.readFile(path);
  if (!bytes) return `${input.path} doesn't exist.`;
  const saved = await saveVersion(context.organizationId, {
    name,
    kind: "deliverable",
    bytes,
    taskId: context.taskId,
    agentId: context.agentId,
    note: input.note,
  });
  if (saved.unchanged) return `${name} is unchanged since version ${saved.version}.`;
  // Build the preview now, so the task page opens it instantly.
  await versionPreview(context.organizationId, saved.versionId).catch((error) => console.error("Preview failed", error));
  return `Attached ${name} as version ${saved.version}${saved.basedOn ? ` (replaces version ${saved.basedOn})` : ""}.`;
}

/**
 * End of a run that used the sandbox: keep the job's notes and its code
 * (scripts, config, run.sh) in the library, so the job can be rebuilt if the
 * sandbox is ever lost, then stop the sandbox (its disk is kept).
 */
export async function closeSandbox(context: RunContext): Promise<void> {
  "use step";
  const sandbox = await sandboxes().find(sandboxNameFor(context.taskId));
  if (!sandbox) return;
  const notes = await sandbox.readFile(`${JOB_DIR}/NOTES.md`).catch(() => null);
  if (notes) await saveMemory(context.taskId, notes.toString("utf8").slice(0, 50_000));

  const listed = await sandbox.run("bash", [
    "-c",
    `cd ${JOB_DIR} && { find code -maxdepth 1 -type f -size -1M 2>/dev/null; ls run.sh config.json config.yaml config.yml config.toml requirements.txt 2>/dev/null; } | head -50`,
  ]);
  for (const path of listed.stdout.split("\n").map((p) => p.trim()).filter(Boolean)) {
    const name = path.split("/").pop()!;
    if (!SAFE_NAME.test(name)) continue;
    const bytes = await sandbox.readFile(`${JOB_DIR}/${path}`);
    if (!bytes || bytes.includes(0)) continue;
    await saveVersion(context.organizationId, { name, kind: "code", bytes, taskId: context.taskId, agentId: context.agentId });
  }
  await sandbox.stop();
}
