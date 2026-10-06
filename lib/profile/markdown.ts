// The company profile is a single markdown document. Everything the Chief of
// Staff knows about the organisation lives here, so these helpers only ever
// read and rewrite markdown text.

export const SECTIONS = [
  "Overview",
  "Mission, Vision & Values",
  "Goals",
  "People & Responsibilities",
  "Agents",
  "Products & Services",
  "Customers & Market",
  "How We Work",
  "Glossary",
] as const;

export type SectionName = (typeof SECTIONS)[number];

export const PEOPLE_SECTION: SectionName = "People & Responsibilities";

const EMPTY_SECTION = "_Not yet captured._";

export function emptyProfile(companyName = "Our company"): string {
  const body = SECTIONS.map((name) => `## ${name}\n\n${defaultBody(name)}`).join("\n\n");
  return `# ${companyName}\n\n${body}\n`;
}

function defaultBody(name: SectionName): string {
  if (name === "Agents") {
    return "- **Chief of Staff** (agent): coordinates the agent team and keeps this profile up to date.";
  }
  return EMPTY_SECTION;
}

export function getCompanyName(markdown: string): string {
  const match = markdown.match(/^# (.+)$/m);
  return match ? match[1].trim() : "Our company";
}

export function setCompanyName(markdown: string, name: string): string {
  if (/^# .+$/m.test(markdown)) return markdown.replace(/^# .+$/m, `# ${name.trim()}`);
  return `# ${name.trim()}\n\n${markdown}`;
}

type Block = { heading: string; body: string };

function splitSections(markdown: string): { preamble: string; blocks: Block[] } {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      if (current) blocks.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: heading[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return { preamble: preamble.join("\n").trim(), blocks };
}

function joinSections(preamble: string, blocks: Block[]): string {
  const parts = [preamble, ...blocks.map((b) => `## ${b.heading}\n\n${b.body || EMPTY_SECTION}`)];
  return parts.filter(Boolean).join("\n\n") + "\n";
}

export function getSection(markdown: string, name: string): string | undefined {
  return splitSections(markdown).blocks.find((b) => sameHeading(b.heading, name))?.body;
}

/** Replaces a section's body, adding the section (in canonical order) if missing. */
export function setSection(markdown: string, name: string, body: string): string {
  const { preamble, blocks } = splitSections(markdown);
  const existing = blocks.find((b) => sameHeading(b.heading, name));
  if (existing) {
    existing.body = body.trim();
  } else {
    const canonical = SECTIONS.findIndex((s) => sameHeading(s, name));
    const block = { heading: canonical >= 0 ? SECTIONS[canonical] : name.trim(), body: body.trim() };
    // Insert before the first later canonical section so the order stays stable.
    const insertAt =
      canonical < 0
        ? blocks.length
        : blocks.findIndex((b) => SECTIONS.findIndex((s) => sameHeading(s, b.heading)) > canonical);
    blocks.splice(insertAt < 0 ? blocks.length : insertAt, 0, block);
  }
  return joinSections(preamble, blocks);
}

function sameHeading(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// People: a markdown table plus a generated reporting tree.

export type Person = {
  name: string;
  role: string;
  reportsTo: string;
  responsibilities: string;
  contact: string;
};

const PEOPLE_COLUMNS = ["Name", "Role", "Reports to", "Responsibilities", "Contact"];

export function parsePeople(markdown: string): Person[] {
  const body = getSection(markdown, PEOPLE_SECTION) ?? "";
  const rows = body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => splitRow(line));
  // Skip the header and the |---| divider.
  return rows
    .filter((cells) => !cells.every((c) => /^:?-{3,}:?$/.test(c)))
    .filter((cells) => cells[0]?.toLowerCase() !== "name")
    .map(([name = "", role = "", reportsTo = "", responsibilities = "", contact = ""]) => ({
      name: unescapeCell(name),
      role: unescapeCell(role),
      reportsTo: unescapeCell(reportsTo === "—" ? "" : reportsTo),
      responsibilities: unescapeCell(responsibilities),
      contact: unescapeCell(contact),
    }))
    .filter((p) => p.name);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim());
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, "|").trim();
}

export function renderPeople(people: Person[]): string {
  if (people.length === 0) return EMPTY_SECTION;
  const header = `| ${PEOPLE_COLUMNS.join(" | ")} |`;
  const divider = `| ${PEOPLE_COLUMNS.map(() => "---").join(" | ")} |`;
  const rows = people.map(
    (p) =>
      `| ${[p.name, p.role, p.reportsTo || "—", p.responsibilities, p.contact].map(escapeCell).join(" | ")} |`,
  );
  return [header, divider, ...rows, "", "### Reporting lines", "", renderOrgTree(people)].join("\n");
}

export function renderOrgTree(people: Person[]): string {
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const reports = new Map<string, Person[]>();
  const roots: Person[] = [];
  for (const person of people) {
    const manager = person.reportsTo ? byName.get(person.reportsTo.toLowerCase()) : undefined;
    if (manager && manager !== person) {
      const key = manager.name.toLowerCase();
      reports.set(key, [...(reports.get(key) ?? []), person]);
    } else {
      roots.push(person);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const walk = (person: Person, depth: number) => {
    const key = person.name.toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const role = person.role ? `, ${person.role}` : "";
    const external =
      person.reportsTo && !byName.has(person.reportsTo.toLowerCase())
        ? ` (reports to ${person.reportsTo}, not yet listed)`
        : "";
    lines.push(`${"  ".repeat(depth)}- **${person.name}**${role}${external}`);
    for (const report of reports.get(key) ?? []) walk(report, depth + 1);
  };
  roots.forEach((root) => walk(root, 0));
  // Anyone left over is part of a reporting cycle; show them so nothing is lost.
  people.filter((p) => !visited.has(p.name.toLowerCase())).forEach((p) => walk(p, 0));
  return lines.join("\n");
}

export function upsertPerson(markdown: string, update: Partial<Person> & { name: string }): string {
  const people = parsePeople(markdown);
  const index = people.findIndex((p) => p.name.toLowerCase() === update.name.trim().toLowerCase());
  const base: Person =
    index >= 0 ? people[index] : { name: update.name.trim(), role: "", reportsTo: "", responsibilities: "", contact: "" };
  const merged: Person = { ...base };
  for (const key of ["role", "reportsTo", "responsibilities", "contact"] as const) {
    if (update[key] !== undefined) merged[key] = update[key]!.trim();
  }
  if (index >= 0) people[index] = merged;
  else people.push(merged);
  return setSection(markdown, PEOPLE_SECTION, renderPeople(people));
}

export function removePerson(markdown: string, name: string): string {
  const people = parsePeople(markdown);
  const target = name.trim().toLowerCase();
  const remaining = people
    .filter((p) => p.name.toLowerCase() !== target)
    .map((p) => (p.reportsTo.toLowerCase() === target ? { ...p, reportsTo: "" } : p));
  return setSection(markdown, PEOPLE_SECTION, renderPeople(remaining));
}
