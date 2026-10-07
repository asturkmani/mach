import "server-only";

import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";

import { getDb } from "@/lib/db";
import template from "@/sandbox/template.json";
import { JOB_DIR, setupScript } from "@/sandbox/setup.mjs";

// One Vercel Sandbox per job, named after the task and kept until the job is
// archived. Between runs it is stopped (Vercel keeps its disk) and resumed by
// name. Everything above this module talks to the small JobSandbox interface,
// so tests can swap in a fake.

export { JOB_DIR };

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export interface JobSandbox {
  readonly name: string;
  run(cmd: string, args: string[], options?: { cwd?: string; timeoutMs?: number; sudo?: boolean }): Promise<CommandResult>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  /** The file's bytes, or null if it doesn't exist. */
  readFile(path: string): Promise<Buffer | null>;
  /** Sets a marker file's time to now (creating it), for changedFiles. */
  mark(marker: string): Promise<void>;
  /**
   * Files under `dir` (relative to it, hidden ones skipped) modified since
   * `marker` was set, or every file when there is no marker. Empty if `dir`
   * doesn't exist.
   */
  changedFiles(dir: string, marker: string): Promise<{ path: string; size: number }[]>;
  /** Sets what the sandbox may reach and which requests get credentials added on the way out. */
  setNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  /** Resumes the named sandbox, or creates it and runs `seed` once. */
  open(name: string, seed: (sandbox: JobSandbox) => Promise<void>): Promise<JobSandbox>;
  /** The named sandbox if it still exists, without creating one. */
  find(name: string): Promise<JobSandbox | null>;
  remove(name: string): Promise<void>;
}

export const sandboxNameFor = (taskId: string) => `mach-task-${taskId}`;

/** How long a sandbox may sit running before Vercel stops it (it is also stopped at the end of every run). */
const SESSION_TIMEOUT_MS = 30 * 60_000;

// The SDK pins its own HTTP agent, which skips Node's proxy support. When the
// process is told to use the environment's proxy (NODE_USE_ENV_PROXY), send
// its requests through the global fetch so they take the proxy too.
const sdkFetch: typeof fetch | undefined = process.env.NODE_USE_ENV_PROXY
  ? (url, init) => {
      const rest: RequestInit & { dispatcher?: unknown } = { ...init };
      delete rest.dispatcher;
      return fetch(url, rest);
    }
  : undefined;

function wrap(sandbox: Sandbox): JobSandbox {
  return {
    name: sandbox.name,
    async run(cmd, args, options = {}) {
      const result = await sandbox.runCommand({
        cmd,
        args,
        cwd: options.cwd,
        sudo: options.sudo,
        timeoutMs: options.timeoutMs,
      });
      return { exitCode: result.exitCode ?? -1, stdout: await result.stdout(), stderr: await result.stderr() };
    },
    async writeFiles(files) {
      await sandbox.writeFiles(files);
    },
    async readFile(path) {
      return sandbox.readFileToBuffer({ path });
    },
    async mark(marker) {
      await sandbox.runCommand({ cmd: "touch", args: [marker] });
    },
    async changedFiles(dir, marker) {
      // Our folders and markers are fixed paths without spaces.
      const list = (newer: string) => `find . -type f ${newer} -not -path '*/.*' -printf '%P\\t%s\\n'`;
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `cd ${dir} 2>/dev/null || exit 0; if [ -e ${marker} ]; then ${list(`-newer ${marker}`)}; else ${list("")}; fi | head -1000`,
        ],
      });
      return (await result.stdout())
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [path, size] = line.split("\t");
          return { path, size: Number(size) };
        });
    },
    async setNetworkPolicy(policy) {
      await sandbox.update({ networkPolicy: policy });
    },
    async stop() {
      await sandbox.stop();
    },
  };
}

async function templateSnapshot(): Promise<string | null> {
  const [row] = await getDb().query<{ snapshot_id: string }>("select snapshot_id from sandbox_templates where key = $1", [
    template.key,
  ]);
  return row?.snapshot_id ?? null;
}

const vercelProvider: SandboxProvider = {
  async open(name, seed) {
    const snapshotId = await templateSnapshot();
    const common = {
      name,
      persistent: true,
      resources: { vcpus: 2 },
      timeout: SESSION_TIMEOUT_MS,
      tags: { app: "mach" },
      fetch: sdkFetch,
    };
    const sandbox = await Sandbox.getOrCreate({
      ...common,
      ...(snapshotId ? { source: { type: "snapshot" as const, snapshotId } } : { image: template.image }),
      onCreate: async (created) => {
        const job = wrap(created);
        if (!snapshotId) {
          // No prebuilt template: install the data stack now (about half a minute, once per job).
          const setup = await job.run("bash", ["-c", setupScript(template)], { sudo: true, timeoutMs: 240_000 });
          if (setup.exitCode !== 0) throw new Error(`Sandbox setup failed: ${setup.stderr.slice(-500)}`);
        }
        await seed(job);
      },
    });
    return wrap(sandbox);
  },
  async find(name) {
    try {
      return wrap(await Sandbox.get({ name, fetch: sdkFetch }));
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null;
      throw error;
    }
  },
  async remove(name) {
    try {
      const sandbox = await Sandbox.get({ name, fetch: sdkFetch });
      await sandbox.delete();
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return;
      throw error;
    }
  },
};

let provider: SandboxProvider = vercelProvider;

/** Tests swap in a fake sandbox; null restores Vercel's. */
export function setSandboxProvider(next: SandboxProvider | null): void {
  provider = next ?? vercelProvider;
}

export function sandboxes(): SandboxProvider {
  return provider;
}
