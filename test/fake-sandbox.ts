import { JOB_DIR, type JobSandbox, type SandboxProvider } from "@/lib/sandbox";

// An in-memory stand-in for Vercel Sandbox. Scripts are "run" by handlers
// keyed on their file name, which can read and write the fake filesystem.
// The log records what matters to tests (creates, script runs, other shell
// commands, stops), not the bookkeeping the steps do.

type Handler = (files: Map<string, Buffer>) => { stdout?: string; stderr?: string; exitCode?: number } | void;

type Machine = {
  files: Map<string, Buffer>;
  written: Map<string, number>;
  marks: Map<string, number>;
  running: boolean;
  /** Every network policy set, in order. */
  policies: unknown[];
};

const ok = { exitCode: 0, stdout: "", stderr: "" };
const hidden = (relative: string) => relative.split("/").some((part) => part.startsWith("."));

export function fakeSandboxes(scripts: Record<string, Handler> = {}) {
  const machines = new Map<string, Machine>();
  const log: string[] = [];
  let clock = 0;

  function sandbox(name: string): JobSandbox {
    const m = machines.get(name)!;
    const write = (path: string, content: Buffer) => {
      m.files.set(path, content);
      m.written.set(path, ++clock);
    };
    const under = (dir: string) =>
      [...m.files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).filter((p) => !hidden(p));
    return {
      name,
      async run(cmd, args) {
        m.running = true;
        if (cmd === "mkdir") return ok;
        if (cmd === "mv") {
          const [from, to] = args.filter((a) => !a.startsWith("-"));
          if (m.marks.has(from)) m.marks.set(to, m.marks.get(from)!);
          m.marks.delete(from);
          return ok;
        }
        if (cmd === "python3" || cmd === "node" || (cmd === "bash" && args[0]?.startsWith(JOB_DIR))) {
          const script = args[0].split("/").pop()!;
          log.push(`run ${script}`);
          const before = new Map(m.files);
          const result = scripts[script]?.(m.files) ?? {};
          for (const [path, content] of m.files) if (before.get(path) !== content) m.written.set(path, ++clock);
          return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        }
        const script = args.join(" ");
        if (script.includes("[ -d /vercel/drive ]")) return ok;
        if (script.includes("find code")) {
          const listed = under(JOB_DIR).filter((p) => p.startsWith("code/") || /^(run\.sh|config\.\w+|requirements\.txt)$/.test(p));
          return { ...ok, stdout: listed.join("\n") };
        }
        const listing = script.match(/cd (\S+) 2>\/dev\/null && find \. -type f/);
        if (listing) return { ...ok, stdout: under(listing[1]).sort().join("\n") };
        const removing = script.match(/^-c rm -f (.+)$/);
        if (removing) {
          for (const [, path] of removing[1].matchAll(/'([^']+)'/g)) {
            m.files.delete(path);
            m.written.delete(path);
          }
          return ok;
        }
        log.push(`shell ${script}`);
        return ok;
      },
      async writeFiles(files) {
        for (const f of files) write(f.path, f.content);
      },
      async readFile(path) {
        return m.files.get(path) ?? null;
      },
      async mark(marker) {
        m.marks.set(marker, ++clock);
      },
      async changedFiles(dir, marker) {
        const since = m.marks.get(marker) ?? -1;
        return under(dir)
          .filter((p) => (m.written.get(`${dir}/${p}`) ?? 0) > since)
          .map((p) => ({ path: p, size: m.files.get(`${dir}/${p}`)!.length }));
      },
      async setNetworkPolicy(policy) {
        m.policies.push(policy);
      },
      async stop() {
        m.running = false;
        log.push(`stop ${name}`);
      },
    };
  }

  const provider: SandboxProvider = {
    async open(name, seed) {
      if (!machines.has(name)) {
        machines.set(name, { files: new Map(), written: new Map(), marks: new Map(), running: true, policies: [] });
        log.push(`create ${name}`);
        await seed(sandbox(name));
      }
      return sandbox(name);
    },
    async find(name) {
      return machines.has(name) ? sandbox(name) : null;
    },
    async remove(name) {
      machines.delete(name);
      log.push(`delete ${name}`);
    },
  };

  return {
    provider,
    machines,
    log,
    file: (name: string, path: string) => machines.get(name)?.files.get(path.startsWith("/") ? path : `${JOB_DIR}/${path}`),
  };
}
