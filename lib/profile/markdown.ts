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
// People live in the database; their section of the profile is generated from
// it as a markdown table plus a reporting tree.

export type ProfilePerson = {
  name: string;
  role: string;
  reportsTo: string;
  responsibilities: string;
  contact: string;
};

const PEOPLE_COLUMNS = ["Name", "Role", "Reports to", "Responsibilities", "Contact"];

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export function renderPeople(people: ProfilePerson[]): string {
  if (people.length === 0) return EMPTY_SECTION;
  const header = `| ${PEOPLE_COLUMNS.join(" | ")} |`;
  const divider = `| ${PEOPLE_COLUMNS.map(() => "---").join(" | ")} |`;
  const rows = people.map(
    (p) =>
      `| ${[p.name, p.role, p.reportsTo || "—", p.responsibilities, p.contact].map(escapeCell).join(" | ")} |`,
  );
  return [header, divider, ...rows, "", "### Reporting lines", "", renderOrgTree(people)].join("\n");
}

export function renderOrgTree(people: ProfilePerson[]): string {
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const reports = new Map<string, ProfilePerson[]>();
  const roots: ProfilePerson[] = [];
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
  const walk = (person: ProfilePerson, depth: number) => {
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

// ---------------------------------------------------------------------------
// Onboarding only needs the essentials; everything else is filled in later.

export type ChecklistItem = { label: string; done: boolean; detail?: string };

export function isCaptured(markdown: string, section: string): boolean {
  const body = getSection(markdown, section)?.trim() ?? "";
  return body !== "" && body !== EMPTY_SECTION;
}

/**
 * What onboarding still needs. A company of one is fine: `justMe` says the
 * person has confirmed nobody else works there, so their own entry is the team.
 */
export function onboardingChecklist(markdown: string, { justMe = false }: { justMe?: boolean } = {}): ChecklistItem[] {
  const peopleBody = getSection(markdown, PEOPLE_SECTION) ?? "";
  const people = peopleBody
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Name |") && !line.startsWith("| ---"))
    .map((line) => line.split(" | "));
  // One person (the founder or CEO) is expected to report to no one.
  const withoutManager = people.filter((cells) => cells[2]?.trim() === "—").length;
  return [
    { label: "What the company does", done: isCaptured(markdown, "Overview") },
    {
      label: "Team and reporting lines",
      done: (people.length > 1 || (justMe && people.length === 1)) && withoutManager <= 1,
      detail:
        people.length === 0
          ? undefined
          : `${people.length} ${people.length === 1 ? "person" : "people"}${
              withoutManager > 1 ? `, ${withoutManager - 1} ${withoutManager === 2 ? "needs" : "need"} a manager` : ""
            }`,
    },
    { label: "Top priorities", done: isCaptured(markdown, "Goals") },
  ];
}
