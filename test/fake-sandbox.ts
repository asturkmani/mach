import { JOB_DIR, type JobSandbox, type SandboxProvider } from "@/lib/sandbox";

// An in-memory stand-in for Vercel Sandbox. Scripts are "run" by handlers
// keyed on their file name, which can read and write the fake filesystem.

type Handler = (files: Map<string, Buffer>) => { stdout?: string; stderr?: string; exitCode?: number } | void;

export function fakeSandboxes(scripts: Record<string, Handler> = {}) {
  const machines = new Map<string, { files: Map<string, Buffer>; mark: number; written: Map<string, number>; running: boolean }>();
  const log: string[] = [];
  let clock = 0;

  function sandbox(name: string): JobSandbox {
    const m = machines.get(name)!;
    const write = (path: string, content: Buffer) => {
      m.files.set(path, content);
      m.written.set(path, ++clock);
    };
    return {
      name,
      async run(cmd, args) {
        m.running = true;
        if (cmd === "mkdir") return { exitCode: 0, stdout: "", stderr: "" };
        if (cmd === "touch") {
          m.mark = ++clock;
          return { exitCode: 0, stdout: "", stderr: "" };
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
        if (script.includes("find outputs") && script.includes("-newer")) {
          const changed = [...m.written]
            .filter(([path, at]) => path.startsWith(`${JOB_DIR}/outputs/`) && at > m.mark)
            .map(([path]) => `${path.slice(`${JOB_DIR}/outputs/`.length)} (${m.files.get(path)!.length} bytes)`);
          return { exitCode: 0, stdout: changed.join("\n"), stderr: "" };
        }
        if (script.includes("find code")) {
          const listed = [...m.files.keys()]
            .map((p) => p.slice(JOB_DIR.length + 1))
            .filter((p) => p.startsWith("code/") || /^(run\.sh|config\.\w+|requirements\.txt)$/.test(p));
          return { exitCode: 0, stdout: listed.join("\n"), stderr: "" };
        }
        if (script.includes("find .")) {
          const listed = [...m.files.keys()].map((p) => p.slice(JOB_DIR.length + 1)).sort();
          return { exitCode: 0, stdout: listed.join("\n"), stderr: "" };
        }
        log.push(`shell ${script}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async writeFiles(files) {
        for (const f of files) write(f.path, f.content);
      },
      async readFile(path) {
        return m.files.get(path) ?? null;
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
        machines.set(name, { files: new Map(), mark: 0, written: new Map(), running: true });
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

  return { provider, machines, log, file: (name: string, path: string) => machines.get(name)?.files.get(`${JOB_DIR}/${path}`) };
}
