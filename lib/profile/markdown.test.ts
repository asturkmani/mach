import { describe, expect, it } from "vitest";

import {
  emptyProfile,
  getCompanyName,
  getSection,
  onboardingChecklist,
  renderPeople,
  setCompanyName,
  setSection,
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

const person = (name: string, role: string, reportsTo = "") => ({
  name,
  role,
  reportsTo,
  responsibilities: "",
  contact: "",
});

describe("people section", () => {
  it("renders a table and a nested reporting tree", () => {
    const section = renderPeople([
      person("Aisha Khan", "Founder & CEO"),
      person("Sam Lee", "Head of Sales", "Aisha Khan"),
      person("Priya Patel", "Account Manager", "Sam Lee"),
    ]);
    expect(section).toContain("| Sam Lee | Head of Sales | Aisha Khan |");
    expect(section).toContain(
      "- **Aisha Khan**, Founder & CEO\n  - **Sam Lee**, Head of Sales\n    - **Priya Patel**, Account Manager",
    );
  });

  it("escapes pipes in cells", () => {
    expect(renderPeople([{ ...person("Sam", "Sales"), responsibilities: "New | renewals" }])).toContain(
      "New \\| renewals",
    );
  });

  it("survives a reporting cycle", () => {
    const section = renderPeople([person("A", "", "B"), person("B", "", "A")]);
    expect(section).toContain("**A**");
    expect(section).toContain("**B**");
  });
});

describe("onboarding checklist", () => {
  it("starts with nothing done", () => {
    expect(onboardingChecklist(emptyProfile()).map((i) => i.done)).toEqual([false, false, false]);
  });

  it("ticks off the essentials", () => {
    let md = setSection(emptyProfile(), "Overview", "Family office for the Cedar family.");
    md = setSection(md, "Goals", "- Cash flow");
    md = setSection(md, "People & Responsibilities", renderPeople([person("Ahmed", "Principal"), person("Mustapha", "Finance", "Ahmed")]));
    expect(onboardingChecklist(md)).toEqual([
      { label: "What the company does", done: true },
      { label: "Team and reporting lines", done: true, detail: "2 people" },
      { label: "Top priorities", done: true },
    ]);
  });

  it("takes one person as the whole team only once they've said it's just them", () => {
    const md = setSection(emptyProfile(), "People & Responsibilities", renderPeople([person("Ahmed", "Founder")]));
    expect(onboardingChecklist(md)[1].done).toBe(false);
    expect(onboardingChecklist(md, { justMe: true })[1]).toEqual({ label: "Team and reporting lines", done: true, detail: "1 person" });
    expect(onboardingChecklist(emptyProfile(), { justMe: true })[1].done).toBe(false);
  });

  it("flags people without a manager", () => {
    const md = setSection(
      emptyProfile(),
      "People & Responsibilities",
      renderPeople([person("Ahmed", "Principal"), person("Mustapha", "Finance"), person("Lina", "Ops")]),
    );
    expect(onboardingChecklist(md)[1]).toEqual({
      label: "Team and reporting lines",
      done: false,
      detail: "3 people, 2 need a manager",
    });
  });
});
