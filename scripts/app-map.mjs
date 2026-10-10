// Writes lib/app-map.json: every screen in the app, with its address, where
// it is in the menus and what it's for, from the `// @map Title | Where |
// What` line at the top of each page. The Chief of Staff reads it to send
// people to the right screen. Runs on every build; `--check` fails instead
// of writing when the file is out of date or a page has no @map line.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const appDir = join(root, "app", "(app)");
const out = join(root, "lib", "app-map.json");

function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

export function buildMap() {
  const screens = [];
  const missing = [];
  for (const file of pages(appDir)) {
    const segments = relative(appDir, file).split(sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
    const path = "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
    const line = readFileSync(file, "utf8").match(/^\/\/ @map (.+)$/m)?.[1];
    if (!line) missing.push(relative(root, file));
    else if (!line.startsWith("hidden")) {
      const [title, where, what] = line.split(" | ").map((s) => s.trim());
      screens.push({ path, title, where, what });
    }
  }
  screens.sort((a, b) => a.path.localeCompare(b.path));
  return { screens, missing };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { screens, missing } = buildMap();
  if (missing.length) {
    console.error(`Pages without an @map line (add "// @map Title | Where | What"):\n${missing.join("\n")}`);
    process.exit(1);
  }
  const json = `${JSON.stringify(screens, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== json) {
      console.error("lib/app-map.json is out of date: run node scripts/app-map.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(out, json);
    console.log(`Wrote ${screens.length} screens to lib/app-map.json`);
  }
}
