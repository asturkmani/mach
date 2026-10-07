// Builds the sandbox template every job sandbox starts from (the Python data
// stack, LibreOffice, the recalc helper, headless Chromium) and records its
// snapshot. The sandbox it was built in is deleted; the snapshot stays.
// Usage: pnpm sandbox:template   (needs DATABASE_URL and Vercel credentials)
import { neon } from "@neondatabase/serverless";
import { Sandbox } from "@vercel/sandbox";

import template from "../sandbox/template.json" with { type: "json" };
import { setupScript } from "../sandbox/setup.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// Same proxy handling as lib/sandbox.ts.
const fetchOption = process.env.NODE_USE_ENV_PROXY
  ? (input, init = {}) => {
      const rest = { ...init };
      delete rest.dispatcher;
      return fetch(input, rest);
    }
  : undefined;

const started = Date.now();
const sandbox = await Sandbox.create({
  name: `mach-template-${template.key}-${Date.now()}`,
  image: template.image,
  resources: { vcpus: 2 },
  timeout: 15 * 60_000,
  fetch: fetchOption,
});
console.log(`Building ${template.key} in ${sandbox.name}…`);
const setup = await sandbox.runCommand({ cmd: "bash", args: ["-c", setupScript(template)], sudo: true });
if (setup.exitCode !== 0) {
  console.error(await setup.stderr());
  await sandbox.delete();
  process.exit(1);
}
const snapshot = await sandbox.snapshot({ expiration: 0 });
await neon(url).query(
  `insert into sandbox_templates (key, snapshot_id) values ($1, $2)
   on conflict (key) do update set snapshot_id = excluded.snapshot_id, created_at = now()`,
  [template.key, snapshot.snapshotId],
);
await sandbox.delete();
console.log(`Saved template ${template.key} as snapshot ${snapshot.snapshotId} in ${Math.round((Date.now() - started) / 1000)}s.`);
