import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

import { agentModel, codingAgent, createAgent, getAgent, updateAgent } from "./store";

const ORG = "org_cedar";

describe("the model each agent runs on", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    vi.stubEnv("CHIEF_OF_STAFF_MODEL", "cheap/assistant");
    vi.stubEnv("AGENT_MODEL", "solid/worker");
    vi.stubEnv("CODING_AGENT_MODEL", "strong/coder");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses an agent's own model, else the default for its kind", async () => {
    const analyst = await createAgent(ORG, { name: "Analyst" });
    expect(agentModel(analyst)).toBe("solid/worker");
    expect(agentModel(await codingAgent(ORG))).toBe("strong/coder");

    await updateAgent(ORG, analyst.id, { model: "anthropic/claude-sonnet-4.5" });
    expect(agentModel((await getAgent(ORG, analyst.id))!)).toBe("anthropic/claude-sonnet-4.5");
    // Saving other fields leaves it; clearing it goes back to the default.
    await updateAgent(ORG, analyst.id, { role: "Numbers" });
    expect((await getAgent(ORG, analyst.id))!.model).toBe("anthropic/claude-sonnet-4.5");
    await updateAgent(ORG, analyst.id, { model: "" });
    expect(agentModel((await getAgent(ORG, analyst.id))!)).toBe("solid/worker");

    await expect(updateAgent(ORG, analyst.id, { model: "not a model" })).rejects.toThrow("isn't a model id");
    vi.stubEnv("AGENT_MODEL", "");
    expect(agentModel(analyst)).toBe("cheap/assistant");
  });
});
