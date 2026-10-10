import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

import { agentModel, codingAgent, createAgent, getAgent, updateAgent } from "./store";

const ORG = "org_cedar";

describe("the model each agent runs on", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses an agent's own model, else the company's, else Mach1's for its role", async () => {
    const analyst = await createAgent(ORG, { name: "Analyst" });
    expect(agentModel(analyst)).toBe("mach1/worker");
    expect(agentModel(await codingAgent(ORG))).toBe("mach1/coder");
    expect(agentModel(analyst, { agents: "openai/gpt-6.1-sol" })).toBe("openai/gpt-6.1-sol");

    await updateAgent(ORG, analyst.id, { model: "anthropic/claude-sonnet-4.5" });
    expect(agentModel((await getAgent(ORG, analyst.id))!)).toBe("anthropic/claude-sonnet-4.5");
    // Saving other fields leaves it; clearing it goes back to the default.
    await updateAgent(ORG, analyst.id, { role: "Numbers" });
    expect((await getAgent(ORG, analyst.id))!.model).toBe("anthropic/claude-sonnet-4.5");
    await updateAgent(ORG, analyst.id, { model: "" });
    expect(agentModel((await getAgent(ORG, analyst.id))!)).toBe("mach1/worker");

    await expect(updateAgent(ORG, analyst.id, { model: "not a model" })).rejects.toThrow("isn't a model id");
  });
});
