import { describe, expect, it } from "vitest";

import {
  emptyProfile,
  getCompanyName,
  getSection,
  parsePeople,
  removePerson,
  setCompanyName,
  setSection,
  upsertPerson,
} from "./markdown";

describe("sections", () => {
  it("replaces a section body and keeps the others", () => {
    const md = setSection(emptyProfile(), "Goals", "- Reach 100 customers by Q2");
    expect(getSection(md, "Goals")).toBe("- Reach 100 customers by Q2");
    expect(getSection(md, "Overview")).toBe("_Not yet captured._");
  });

  it("adds a missing canonical section in order", () => {
    const md = "# Acme\n\n## Overview\n\nWe sell things.\n\n## Glossary\n\nNone.\n";
    const updated = setSection(md, "goals", "Grow");
    const headings = [...updated.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Overview", "Goals", "Glossary"]);
  });

  it("sets the company name", () => {
    const md = setCompanyName(emptyProfile(), "Greenfield Supplies");
    expect(getCompanyName(md)).toBe("Greenfield Supplies");
    expect(md.match(/^# /gm)).toHaveLength(1);
  });
});

describe("people", () => {
  const withTeam = () => {
    let md = emptyProfile("Greenfield Supplies");
    md = upsertPerson(md, { name: "Aisha Khan", role: "Founder & CEO", reportsTo: "" });
    md = upsertPerson(md, { name: "Sam Lee", role: "Head of Sales", reportsTo: "Aisha Khan" });
    md = upsertPerson(md, { name: "Priya Patel", role: "Account Manager", reportsTo: "Sam Lee" });
    return md;
  };

  it("round-trips people through the markdown table", () => {
    const people = parsePeople(withTeam());
    expect(people.map((p) => [p.name, p.reportsTo])).toEqual([
      ["Aisha Khan", ""],
      ["Sam Lee", "Aisha Khan"],
      ["Priya Patel", "Sam Lee"],
    ]);
  });

  it("renders a nested reporting tree", () => {
    const section = getSection(withTeam(), "People & Responsibilities")!;
    expect(section).toContain(
      "- **Aisha Khan**, Founder & CEO\n  - **Sam Lee**, Head of Sales\n    - **Priya Patel**, Account Manager",
    );
  });

  it("updates only the fields passed", () => {
    const md = upsertPerson(withTeam(), { name: "sam lee", responsibilities: "New business | renewals" });
    const sam = parsePeople(md).find((p) => p.name === "Sam Lee")!;
    expect(sam).toMatchObject({ role: "Head of Sales", reportsTo: "Aisha Khan", responsibilities: "New business | renewals" });
  });

  it("flags managers that are not listed yet", () => {
    const md = upsertPerson(emptyProfile(), { name: "Tom", role: "Driver", reportsTo: "Jo" });
    expect(getSection(md, "People & Responsibilities")).toContain("**Tom**, Driver (reports to Jo, not yet listed)");
  });

  it("removes a person and clears their reports' manager", () => {
    const md = removePerson(withTeam(), "Sam Lee");
    expect(parsePeople(md).map((p) => [p.name, p.reportsTo])).toEqual([
      ["Aisha Khan", ""],
      ["Priya Patel", ""],
    ]);
  });

  it("survives a reporting cycle", () => {
    let md = upsertPerson(emptyProfile(), { name: "A", reportsTo: "B" });
    md = upsertPerson(md, { name: "B", reportsTo: "A" });
    const section = getSection(md, "People & Responsibilities")!;
    expect(section).toContain("**A**");
    expect(section).toContain("**B**");
  });
});
