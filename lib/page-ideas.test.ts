import { beforeEach, describe, expect, it } from "vitest";

import { saveIntegration } from "@/lib/integrations";
import { createOrganization } from "@/lib/orgs";
import { pageIdeas } from "@/lib/page-ideas";
import { setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

const reply = (ideas: object[]) => JSON.stringify({ ideas });
const NET_WORTH = {
  title: "Net worth by entity and asset class, every weekday at 7am",
  prompt: "Build me a page of our net worth by entity and asset class from Masttro, refreshed every weekday at 7am.",
  source: "Masttro",
  needsConnecting: "Masttro",
};

describe("page ideas", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    await updateProfile(ORG, (md) => setSection(md, "Overview", "A single-family office in London. Reporting runs on Masttro."));
  });

  it("are written for the company from its profile and integrations, and kept until those change", async () => {
    // Masttro is only connected as a login for reading its docs, so the idea says to connect its API first.
    await saveIntegration(ORG, {
      kind: "login",
      name: "Masttro documentation",
      config: { loginUrl: "https://dfo.masttro.example/api/index.html", domains: [], fields: [] },
    });
    const model = scriptedModel([reply([NET_WORTH])]);
    expect(await pageIdeas(ORG, { model })).toEqual([NET_WORTH]);
    const asked = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(asked).toContain("Reporting runs on Masttro");
    expect(asked).toContain("Masttro documentation (website login only, for a browser; its API isn't connected");

    // Nothing changed: no new call.
    expect(await pageIdeas(ORG, { model: scriptedModel([new Error("should be cached")]) })).toEqual([NET_WORTH]);

    // Connecting the API changes what's possible, so the ideas are written again.
    await saveIntegration(ORG, {
      kind: "api",
      name: "Masttro",
      config: { baseUrl: "https://api.masttro.example/v1", domains: [], fields: [{ name: "apiKey", label: "API key" }] },
    });
    const connected = { ...NET_WORTH, needsConnecting: "" };
    const again = scriptedModel([reply([connected])]);
    expect(await pageIdeas(ORG, { model: again })).toEqual([{ ...connected, needsConnecting: null }]);
    expect(JSON.stringify(again.doGenerateCalls[0].prompt)).toContain("Masttro (data source, agents can read its API");
  });

  it("are empty, not an error, when the model fails", async () => {
    expect(await pageIdeas(ORG, { model: scriptedModel([new Error("gateway down")]) })).toEqual([]);
  });
});
