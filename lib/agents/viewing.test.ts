import { beforeEach, describe, expect, it } from "vitest";

import { loadChiefOfStaff } from "@/lib/agents/cos-turn";
import { describeViewing } from "@/lib/agents/viewing";
import { writeDriveFile } from "@/lib/drive";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { savePage } from "@/lib/pages";
import { linkMember } from "@/lib/people";
import { createTask } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

describe("what someone is looking at while they talk to the Chief of Staff", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("names the screen from its path, looked up for this company only", async () => {
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    await createTask(ORG, { title: "Renew the Chelsea insurance", priority: "urgent", people: [ahmed.id] });
    await writeDriveFile(ORG, { path: "pages/fx/data.json", bytes: Buffer.from("{}") });
    await savePage(ORG, { title: "Currency exposure", html: "<p>1</p>", data: ["pages/fx/data.json"], by: { name: "Ahmed" } });
    await savePage(ORG, { slug: "currency-exposure", title: "Currency exposure", html: "<p>2</p>", data: ["pages/fx/data.json"], by: { name: "Ahmed" } });

    expect(await describeViewing(ORG, "/tasks/1")).toBe(
      'task #1 "Renew the Chelsea insurance" (ready, urgent priority; people: Ahmed)',
    );
    expect(await describeViewing(ORG, "/pages/currency-exposure?v=1")).toBe(
      `the "Currency exposure" page (slug currency-exposure, version 2, though they're viewing its old version 1; reads pages/fx/data.json). Use read_page before changing it`,
    );
    expect(await describeViewing(ORG, "/")).toMatch(/^Home/);
    expect(await describeViewing(ORG, "/settings/integrations")).toBe("Settings › Integrations");

    // Another company's task, or nothing there: not named.
    await createOrganization({ id: "org_oak", name: "Oak" });
    expect(await describeViewing("org_oak", "/tasks/1")).toBeNull();
    expect(await describeViewing(ORG, "/tasks/99")).toBeNull();
    expect(await describeViewing(ORG, "/something-else")).toBeNull();
  });

  it("is in the Chief of Staff's instructions, so 'this' means the page on screen", async () => {
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    await writeDriveFile(ORG, { path: "pages/fx/data.json", bytes: Buffer.from("{}") });
    await savePage(ORG, { title: "Currency exposure", html: "<p>1</p>", data: ["pages/fx/data.json"], by: { name: "Ahmed" } });
    const organization = (await getOrganization(ORG))!;
    const model = scriptedModel(["Sure."]);
    const { agent } = await loadChiefOfStaff(
      { organization, user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" }, person: ahmed },
      { model, research: false, viewing: "/pages/currency-exposure" },
    );
    await agent.generate({ prompt: "Add a chart to this" });
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(`Right now they're looking at the \\"Currency exposure\\" page`);
  });
});
