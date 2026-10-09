import { createHash } from "node:crypto";

import { DRIVE_DIR, drivePath, listDrive, MAX_DRIVE_FILE_BYTES, readDriveFile, writeDriveFile } from "@/lib/drive";
import { contentTypeFor, isText, listTaskFiles, readTaskFiles, readVersion, saveVersion, type FileKind } from "@/lib/files";
import { saveLoginSessions, waitingForCode } from "@/lib/agents/browser-steps";
import { commitIdentity, githubSigning, githubToken } from "@/lib/github";
import { knownSecrets, sandboxPolicy } from "@/lib/integrations";
import { redact } from "@/lib/secrets";
import { versionPreview } from "@/lib/previews";
import type { AgentContext, RunContext } from "@/lib/agents/prompts";
import { JOB_DIR, openCompanySandbox, sandboxes, sandboxNameOf, type CommandResult, type JobSandbox } from "@/lib/sandbox";
import { getTask, saveMemory, setSandboxName } from "@/lib/tasks";

// The sandbox tools every agent uses, each a durable workflow step. An agent
// on a task works in the job's sandbox, created on first use, seeded with the
// job's files and notes, and stopped (not deleted) at the end of the run. The
// Chief of Staff works in the company's workspace sandbox the same way, minus
// the job. The company drive is synced into both at /vercel/drive: pulled
// when a run starts, pushed after every command.

/** A single command may run this long; longer work is split into steps. */
export const COMMAND_TIMEOUT_MS = 240_000;

const OUTPUT_LIMIT = 6000;
const clip = (text: string, max = OUTPUT_LIMIT) =>
  text.length > max ? `${text.slice(0, max / 2)}\n[…${text.length - max} characters cut…]\n${text.slice(-max / 2)}` : text;

/** Removes the company's stored credentials from text an agent reads back from its sandbox. */
async function scrub(context: AgentContext, text: string): Promise<string> {
  return redact(text, await knownSecrets(context.organizationId));
}

const SAFE_NAME = /^[\w][\w.-]{0,79}$/;
const INTERPRETERS = { python: "python3", node: "node", bash: "bash" } as const;

/** Set before each command, to find the outputs it wrote. */
const RUN_MARK = `${JOB_DIR}/.mark`;
/** What this sandbox has from the drive: path → sha256. */
const DRIVE_MANIFEST = `${JOB_DIR}/.drive.json`;
/** Set after each sync: drive files newer than this were written here since. */
const DRIVE_SYNCED = `${JOB_DIR}/.drive-synced`;
const DRIVE_SYNCING = `${JOB_DIR}/.drive-syncing`;
/** At most this much is copied in from the drive when a run starts. */
const DRIVE_PULL_BUDGET = 1024 * 1024 * 1024;

/**
 * Resolves a path inside the job folder, or inside the company drive when it
 * starts with /vercel/drive. Anything else is refused.
 */
export function sandboxPath(path: string): string {
  const trimmed = path.trim();
  if (/^\/vercel\/drive(\/|$)/.test(trimmed)) return `${DRIVE_DIR}/${drivePath(trimmed)}`;
  const parts: string[] = [];
  for (const part of trimmed.replace(/^\/vercel\/job\/?/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("Paths must stay inside the job folder or /vercel/drive.");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("Give a file path inside the job folder.");
  return `${JOB_DIR}/${parts.join("/")}`;
}

/** Files that belong at the top of the job folder rather than under code/. */
const ROOT_FILES = /^(run\.sh|config\.(json|ya?ml|toml)|requirements\.txt)$/i;

/** Where one of the job's files lives in its sandbox. */
const jobPath = (f: { kind: FileKind; role: "input" | "output"; name: string }) =>
  f.kind === "code"
    ? `${JOB_DIR}/${ROOT_FILES.test(f.name) ? "" : "code/"}${f.name}`
    : `${JOB_DIR}/${f.role === "input" ? "inputs" : "outputs"}/${f.name}`;

/** Which version of each of the job's files the sandbox has (path → version). */
const FILES_MANIFEST = `${JOB_DIR}/.files.json`;

async function seed(context: AgentContext, sandbox: JobSandbox): Promise<void> {
  await sandbox.run("mkdir", ["-p", `${JOB_DIR}/code`, `${JOB_DIR}/inputs`, `${JOB_DIR}/outputs`]);
  if (!context.taskId) return;
  const task = await getTask(context.organizationId, context.taskId);
  const files = await readTaskFiles(context.organizationId, context.taskId);
  const manifest = Object.fromEntries(files.map((f) => [jobPath(f), f.version]));
  await sandbox.writeFiles([
    { path: `${JOB_DIR}/NOTES.md`, content: Buffer.from(task?.memory || "# Job notes\n") },
    { path: FILES_MANIFEST, content: Buffer.from(JSON.stringify(manifest)) },
    ...files.map((f) => ({ path: jobPath(f), content: f.bytes })),
  ]);
}

/**
 * Copies in files people added to the job since the sandbox last had them: an
 * attachment in the thread, a file from the library, a new version of a
 * deliverable. Versions an agent made on this job came from this sandbox, so
 * they're already here (and may have moved on since).
 */
async function syncTaskFiles(context: RunContext, sandbox: JobSandbox): Promise<string[]> {
  const manifest = (await readJson(sandbox, FILES_MANIFEST)) as Record<string, number>;
  const writes: { path: string; content: Buffer }[] = [];
  let changed = false;
  for (const file of await listTaskFiles(context.organizationId, context.taskId)) {
    const latest = file.versions[0];
    if (!latest || file.kind === "code") continue;
    const path = jobPath(file);
    if ((manifest[path] ?? 0) >= latest.version) continue;
    manifest[path] = latest.version;
    changed = true;
    if (latest.taskId === context.taskId && latest.agentName) continue;
    const content = await readVersion(context.organizationId, latest.id);
    if (content) writes.push({ path, content: content.bytes });
  }
  if (changed) writes.push({ path: FILES_MANIFEST, content: Buffer.from(JSON.stringify(manifest)) });
  if (writes.length) await sandbox.writeFiles(writes);
  return writes.filter((w) => w.path !== FILES_MANIFEST).map((w) => w.path.slice(JOB_DIR.length + 1));
}

async function open(context: AgentContext): Promise<JobSandbox> {
  const name = sandboxNameOf(context);
  const sandbox = await openCompanySandbox(context.organizationId, name, (created) => seed(context, created));
  if (context.taskId) await setSandboxName(context.taskId, name);
  return sandbox;
}

// ---------------------------------------------------------------------------
// The company drive

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;

async function readJson(sandbox: JobSandbox, path: string): Promise<Record<string, unknown>> {
  const raw = await sandbox.readFile(path).catch(() => null);
  try {
    return raw ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const readManifest = async (sandbox: JobSandbox) => (await readJson(sandbox, DRIVE_MANIFEST)) as Record<string, string>;

const writeManifest = (sandbox: JobSandbox, manifest: Record<string, string>) =>
  sandbox.writeFiles([{ path: DRIVE_MANIFEST, content: Buffer.from(JSON.stringify(manifest)) }]);

/** Brings the sandbox's copy of the drive up to date: copies in what changed and removes what was deleted. */
async function pullDrive(context: AgentContext, sandbox: JobSandbox): Promise<string> {
  await sandbox.run("bash", ["-c", `[ -d ${DRIVE_DIR} ] || { mkdir -p ${DRIVE_DIR} && chown ubuntu:ubuntu ${DRIVE_DIR}; }`], {
    sudo: true,
  });
  const [manifest, files] = await Promise.all([readManifest(sandbox), listDrive(context.organizationId)]);
  const live = new Set(files.map((f) => f.path));
  const stale = files.filter((f) => manifest[f.path] !== f.sha256).sort((a, b) => a.size - b.size);
  const gone = Object.keys(manifest).filter((path) => !live.has(path));

  let budget = DRIVE_PULL_BUDGET;
  const skipped: string[] = [];
  let batch: { path: string; content: Buffer }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const dirs = [...new Set(batch.map((f) => f.path.slice(0, f.path.lastIndexOf("/"))))];
    await sandbox.run("mkdir", ["-p", ...dirs]);
    await sandbox.writeFiles(batch);
    batch = [];
    batchBytes = 0;
  };
  for (const file of stale) {
    if (file.size > budget) {
      skipped.push(file.path);
      continue;
    }
    const content = await readDriveFile(context.organizationId, file.path);
    if (!content) continue;
    budget -= file.size;
    batch.push({ path: `${DRIVE_DIR}/${file.path}`, content: content.bytes });
    batchBytes += file.size;
    manifest[file.path] = file.sha256;
    if (batchBytes > 64 * 1024 * 1024) await flush();
  }
  await flush();
  if (gone.length) {
    await sandbox.run("bash", ["-c", `rm -f ${gone.map((p) => quote(`${DRIVE_DIR}/${p}`)).join(" ")}`]);
    for (const path of gone) delete manifest[path];
  }
  await writeManifest(sandbox, manifest);
  await sandbox.mark(DRIVE_SYNCED);
  const copied = stale.length - skipped.length;
  return [
    copied && `copied ${copied} changed drive file${copied === 1 ? "" : "s"}`,
    gone.length && `removed ${gone.length} deleted`,
    skipped.length && `left out ${skipped.join(", ")} (over the 1 GB copy limit)`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Saves the files written under /vercel/drive since the last sync to the company drive. Returns notes for the agent. */
async function pushDrive(context: AgentContext, sandbox: JobSandbox): Promise<{ saved: string[]; problems: string[] }> {
  await sandbox.mark(DRIVE_SYNCING);
  const changed = await sandbox.changedFiles(DRIVE_DIR, DRIVE_SYNCED);
  const saved: string[] = [];
  const problems: string[] = [];
  if (changed.length) {
    const manifest = await readManifest(sandbox);
    for (const file of changed) {
      let path: string;
      try {
        path = drivePath(file.path);
      } catch (error) {
        problems.push(`${file.path}: ${(error as Error).message}`);
        continue;
      }
      if (file.size > MAX_DRIVE_FILE_BYTES) {
        problems.push(`${path} is over ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB, so it stays in this sandbox only`);
        continue;
      }
      const bytes = await sandbox.readFile(`${DRIVE_DIR}/${file.path}`);
      if (!bytes) continue;
      const hash = sha256(bytes);
      if (manifest[path] === hash) continue;
      await writeDriveFile(context.organizationId, {
        path,
        bytes,
        taskId: context.taskId ?? undefined,
        agentId: context.agentId ?? undefined,
        personId: context.personId,
      });
      manifest[path] = hash;
      saved.push(path);
    }
    await writeManifest(sandbox, manifest);
  }
  await sandbox.run("mv", ["-f", DRIVE_SYNCING, DRIVE_SYNCED]);
  return { saved, problems };
}

function driveNote({ saved, problems }: { saved: string[]; problems: string[] }): string {
  return [
    saved.length ? `\nsaved to the company drive: ${saved.join(", ")}` : "",
    problems.length ? `\nnot saved to the drive: ${problems.join("; ")}` : "",
  ].join("");
}

/**
 * Lets this run's code reach the company's data sources: requests to them
 * get their credentials added on the way out of the sandbox.
 */
async function connectSources(context: AgentContext, sandbox: JobSandbox): Promise<{ sources: string[]; github: string | null }> {
  const github = await runGitHub(context);
  const { policy, sources } = await sandboxPolicy(context.organizationId, context.agentId, github ? githubSigning(github.token) : {});
  await sandbox.setNetworkPolicy(policy);
  // So the browser accepts the proxy that signs those requests (older templates lack the helper), and
  // commits are signed as the person the run is for.
  const identity = github ? commitIdentity(github.account) : null;
  const setup = [
    sources.length || github ? "(command -v trust-network-proxy >/dev/null && trust-network-proxy || true)" : "",
    identity ? `git config --global user.name ${shellQuote(identity.name)} && git config --global user.email ${shellQuote(identity.email)}` : "",
  ].filter(Boolean);
  if (setup.length) await sandbox.run("bash", ["-c", setup.join("; ")]);
  return { sources, github: github ? github.account.login : null };
}

/**
 * The GitHub of the person this work is for, if they connected it: a task
 * run's person (its sandbox runs one run at a time), or the person whose own
 * sandbox this is (only their turns run there). Never the shared workspace.
 */
async function runGitHub(context: AgentContext) {
  if (!context.personId) return null;
  return githubToken(context.organizationId, context.personId);
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Starts (or resumes) the agent's sandbox for this run, connects data sources and brings its copy of the drive up to date. */
export async function startSandbox(context: AgentContext): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const added = context.taskId ? await syncTaskFiles(context as RunContext, sandbox) : [];
  const { sources, github } = await connectSources(context, sandbox);
  const pulled = await pullDrive(context, sandbox);
  return [
    added.length ? `new on the job: ${added.join(", ")}` : "",
    pulled,
    sources.length ? `data sources connected: ${sources.join(", ")}` : "",
    github ? `GitHub connected as @${github}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Writes bytes to a file in the job folder or on the drive (saved to the drive straight away). */
export async function saveIntoSandbox(context: AgentContext, path: string, bytes: Buffer): Promise<string> {
  const sandbox = await open(context);
  const target = sandboxPath(path);
  await sandbox.run("mkdir", ["-p", target.slice(0, target.lastIndexOf("/"))]);
  await sandbox.writeFiles([{ path: target, content: bytes }]);
  const drive = target.startsWith(`${DRIVE_DIR}/`) ? driveNote(await pushDrive(context, sandbox)) : "";
  return `${target}${drive}`;
}

// ---------------------------------------------------------------------------
// Tools

const formatLog = (result: CommandResult) =>
  [`exit code ${result.exitCode}`, result.stdout && `stdout:\n${clip(result.stdout)}`, result.stderr && `stderr:\n${clip(result.stderr)}`]
    .filter(Boolean)
    .join("\n");

const timedOut = (result: CommandResult) => result.exitCode === 137 || result.exitCode === -1;

async function changedOutputs(sandbox: JobSandbox): Promise<{ path: string; size: number }[]> {
  return (await sandbox.changedFiles(`${JOB_DIR}/outputs`, RUN_MARK)).slice(0, 50);
}

export async function runCode(
  context: AgentContext,
  input: { filename: string; language: keyof typeof INTERPRETERS; code: string },
): Promise<string> {
  "use step";
  if (!SAFE_NAME.test(input.filename)) return "Use a simple file name like simulate.py.";
  const sandbox = await open(context);
  const path = `${JOB_DIR}/code/${input.filename}`;
  await sandbox.writeFiles([{ path, content: Buffer.from(input.code) }]);
  await sandbox.mark(RUN_MARK);
  const result = await sandbox.run(INTERPRETERS[input.language], [path], { cwd: JOB_DIR, timeoutMs: COMMAND_TIMEOUT_MS });
  const changed = await changedOutputs(sandbox);
  const drive = await pushDrive(context, sandbox);
  const log = await scrub(context, formatLog(result));
  // Every script a job runs is kept in the library as code, with the output of its latest run.
  if (context.taskId) {
    await saveVersion(context.organizationId, {
      name: input.filename,
      kind: "code",
      bytes: Buffer.from(input.code),
      taskId: context.taskId,
      agentId: context.agentId ?? undefined,
      note: clip(log, 4000),
    });
  }
  const outputs = changed.map((f) => `${f.path} (${f.size} bytes)`).join(", ");
  return `${log}${outputs ? `\nnew or changed in outputs/: ${outputs}` : ""}${driveNote(drive)}${
    timedOut(result) ? `\nThe script may have hit the ${COMMAND_TIMEOUT_MS / 1000}s limit; split the work into smaller steps.` : ""
  }`;
}

export async function runShell(context: AgentContext, input: { command: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const result = await sandbox.run("bash", ["-lc", input.command], { cwd: JOB_DIR, timeoutMs: COMMAND_TIMEOUT_MS });
  const drive = await pushDrive(context, sandbox);
  return `${await scrub(context, formatLog(result))}${driveNote(drive)}`;
}

export async function readSandboxFile(context: AgentContext, input: { path: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const bytes = await sandbox.readFile(sandboxPath(input.path));
  if (!bytes) return `${input.path} doesn't exist.`;
  if (!isText(contentTypeFor(input.path)) || bytes.includes(0)) {
    return `${input.path} is a binary file (${bytes.length} bytes). Read it with code instead.`;
  }
  return clip(await scrub(context, bytes.toString("utf8")), 20_000);
}

export async function writeSandboxFile(context: AgentContext, input: { path: string; content: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const path = sandboxPath(input.path);
  await sandbox.run("mkdir", ["-p", path.slice(0, path.lastIndexOf("/"))]);
  await sandbox.writeFiles([{ path, content: Buffer.from(input.content) }]);
  const drive = path.startsWith(`${DRIVE_DIR}/`) ? driveNote(await pushDrive(context, sandbox)) : "";
  return `Wrote ${path}.${drive}`;
}

export async function listSandboxFiles(context: AgentContext, input: { folder?: "job" | "drive" } = {}): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const dir = input.folder === "drive" ? DRIVE_DIR : JOB_DIR;
  const result = await sandbox.run("bash", [
    "-c",
    `cd ${dir} 2>/dev/null && find . -type f -not -path '*/.*' -printf '%P\\t%s bytes\\t%TY-%Tm-%Td %TH:%TM\\n' | sort | head -300`,
  ]);
  return result.stdout.trim() || (input.folder === "drive" ? "The company drive is empty." : `The ${context.taskId ? "job" : "workspace"} folder is empty.`);
}

/** Saves a sandbox file to the job as a deliverable (xlsx recalculated first), and builds its preview. */
async function attach(
  context: RunContext,
  sandbox: JobSandbox,
  path: string,
  note: string | undefined,
): Promise<{ name: string; version: number; basedOn: number | null; unchanged: boolean } | string> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!SAFE_NAME.test(name)) return "Give the file a simple name like portfolio-model.xlsx before attaching it.";
  if (/\.xlsx$/i.test(name)) {
    // Store computed values in the workbook so previews and readers see numbers, not just formulas.
    await sandbox.run("bash", ["-c", `command -v recalc >/dev/null && recalc "${path}" || true`], { timeoutMs: 120_000 });
  }
  const bytes = await sandbox.readFile(path);
  if (!bytes) return `${path} doesn't exist.`;
  const saved = await saveVersion(context.organizationId, {
    name,
    kind: "deliverable",
    bytes,
    taskId: context.taskId,
    agentId: context.agentId,
    note,
  });
  if (!saved.unchanged) {
    // Build the preview now, so the task page opens it instantly.
    await versionPreview(context.organizationId, saved.versionId).catch((error) => console.error("Preview failed", error));
  }
  return { name, version: saved.version, basedOn: saved.basedOn, unchanged: saved.unchanged };
}

export async function attachSandboxFile(context: RunContext, input: { path: string; note?: string }): Promise<string> {
  "use step";
  const sandbox = await open(context);
  const result = await attach(context, sandbox, sandboxPath(input.path), input.note);
  if (typeof result === "string") return result;
  if (result.unchanged) return `${result.name} is unchanged since version ${result.version}.`;
  return `Attached ${result.name} as version ${result.version}${result.basedOn ? ` (replaces version ${result.basedOn})` : ""}.`;
}

// ---------------------------------------------------------------------------
// Replays: rerunning run.sh without a model

export type ReplayResult =
  | {
      ok: true;
      /** The last "SUMMARY: …" line run.sh printed. */
      summary: string | null;
      /** Deliverables updated, e.g. "option-flow.png (v6)". */
      attached: string[];
      /** Other files it wrote in outputs/, which aren't deliverables on the job. */
      unattached: string[];
      drive: string[];
      log: string;
    }
  | { ok: false; reason: "no_script" | "failed"; log: string };

export function summaryLine(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => /^\s*SUMMARY:/i.test(l));
  return lines.length ? lines[lines.length - 1].replace(/^\s*SUMMARY:\s*/i, "").trim() || null : null;
}

/**
 * Reruns the job's run.sh: what a scheduled run or "Run again" does when the
 * job has one. Outputs with the same name as a deliverable on the job become
 * its next version.
 */
export async function replayScript(context: RunContext, label: string): Promise<ReplayResult> {
  "use step";
  const sandbox = await open(context);
  await connectSources(context, sandbox);
  await pullDrive(context, sandbox);
  if (!(await sandbox.readFile(`${JOB_DIR}/run.sh`))) {
    return { ok: false, reason: "no_script", log: "There is no run.sh in the job folder." };
  }
  await sandbox.mark(RUN_MARK);
  const result = await sandbox.run("bash", [`${JOB_DIR}/run.sh`], { cwd: JOB_DIR, timeoutMs: COMMAND_TIMEOUT_MS });
  const drive = await pushDrive(context, sandbox);
  const log = `${await scrub(context, formatLog(result))}${driveNote(drive)}${timedOut(result) ? `\nrun.sh may have hit the ${COMMAND_TIMEOUT_MS / 1000}s limit.` : ""}`;
  if (result.exitCode !== 0) return { ok: false, reason: "failed", log };

  const deliverables = new Set(
    (await listTaskFiles(context.organizationId, context.taskId)).filter((f) => f.kind === "deliverable").map((f) => f.name.toLowerCase()),
  );
  const attached: string[] = [];
  const unattached: string[] = [];
  for (const file of await changedOutputs(sandbox)) {
    if (file.path.includes("/") || !deliverables.has(file.path.toLowerCase())) {
      unattached.push(file.path);
      continue;
    }
    const saved = await attach(context, sandbox, `${JOB_DIR}/outputs/${file.path}`, label);
    if (typeof saved !== "string" && !saved.unchanged) attached.push(`${saved.name} (v${saved.version})`);
  }
  return { ok: true, summary: summaryLine(await scrub(context, result.stdout)), attached, unattached, drive: drive.saved, log };
}

/**
 * End of a run that used the sandbox: save anything new on the drive, keep the
 * job's notes and its code (scripts, config, run.sh) in the library, so the
 * job can be rebuilt if the sandbox is ever lost, then stop the sandbox (its
 * disk is kept).
 */
export async function closeSandbox(context: AgentContext): Promise<void> {
  "use step";
  const sandbox = await sandboxes().find(sandboxNameOf(context));
  if (!sandbox) return;
  await pushDrive(context, sandbox).catch((error) => console.error("Drive sync failed", error));
  // Credentials only live in the sandbox's network policy while a run is going.
  await sandbox.setNetworkPolicy("allow-all").catch((error) => console.error("Couldn't reset the network policy", error));
  if (context.taskId) await keepJob(context as RunContext, sandbox);
  await saveLoginSessions(context, sandbox).catch((error) => console.error("Couldn't save browser sessions", error));
  // A sign-in waiting for someone's code keeps the sandbox (and its browser) running until it times out.
  const waiting = context.taskId
    ? Boolean((await getTask(context.organizationId, context.taskId))?.pendingLogin)
    : await waitingForCode(sandbox);
  if (waiting) return;
  await sandbox.stop();
}

/** Keeps the job's notes and code in the library. */
async function keepJob(context: RunContext, sandbox: JobSandbox): Promise<void> {
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
}
