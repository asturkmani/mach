// Writes lib/skills.json: Mach1's base skills, from skills/<name>/SKILL.md.
// Each file starts with front matter (name, description, and optionally tools
// it switches on and a model role), then the playbook itself. Agents see each
// skill's name and description, and load the rest when the work calls for it
// (lib/agents/skills.ts). Runs on every build; `--check` fails instead of
// writing when the file is out of date or a skill is malformed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skillsDir = join(root, "skills");
const out = join(root, "lib", "skills.json");

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

/** A front matter value: "a quoted string", [a, list], or a bare word. */
function value(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("[")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return text;
}

export function parseSkill(text, where = "SKILL.md") {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${where}: no front matter`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at < 1) throw new Error(`${where}: can't read "${line}"`);
    meta[line.slice(0, at).trim()] = value(line.slice(at + 1));
  }
  const body = match[2].trim();
  if (!meta.name || !NAME.test(meta.name)) throw new Error(`${where}: needs a name in lowercase-with-dashes`);
  if (!meta.description) throw new Error(`${where}: needs a description`);
  if (!body) throw new Error(`${where}: is empty`);
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.tools ? { tools: meta.tools } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.extends ? { extends: meta.extends } : {}),
    body,
  };
}

export function buildSkills() {
  const skills = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!statSync(join(skillsDir, name)).isDirectory() || !existsSync(file)) continue;
    const skill = parseSkill(readFileSync(file, "utf8"), relative(root, file));
    if (skill.name !== name) throw new Error(`${relative(root, file)}: its name must match its folder (${name})`);
    skills.push(skill);
  }
  return skills;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let skills;
  try {
    skills = buildSkills();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const json = `${JSON.stringify(skills, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== json) {
      console.error("lib/skills.json is out of date: run node scripts/skills.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(out, json);
    console.log(`Wrote ${skills.length} skills to lib/skills.json`);
  }
}
