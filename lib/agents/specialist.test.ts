import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent, listAgents } from "@/lib/agents/store";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { getTaskByNumber } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

import { setSpecialistModel } from "./specialist";

const ORG = "org_cedar";

describe("asking a defined agent and waiting for the answer", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    setScheduler(() => {}); // task runs aren't part of this test
  });
  afterEach(() => {
    setSpecialistModel(null);
    setScheduler(null);
    vi.unstubAllEnvs();
  });

  async function ask(specialist: string) {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    await createAgent(ORG, { name: "Analyst", role: "Portfolio analysis", instructions: "Always state the as-of date." });
    const specialistModel = scriptedModel([specialist]);
    setSpecialistModel(specialistModel);
    const model = scriptedModel([
      [
        [
          "spawn_worker",
          {
            agent: "Analyst",
            title: "Work out the cash runway",
            brief: "What's our cash runway at the current burn?",
            why: "Sara is planning next year's spending",
            skills: [],
            wait: true,
          },
        ],
      ],
      "Done.",
    ]);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const person = (await getPerson(ORG, sara.id))!;
    await createChiefOfStaff(
      { organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person, profile: "# Cedar Legacy", agents: await listAgents(ORG) },
      { model, research: false },
    ).generate({ prompt: "what's our runway?" });
    return { told: JSON.stringify(model.doGenerateCalls.at(-1)!.prompt), asked: JSON.stringify(specialistModel.doGenerateCalls[0].prompt) };
  }

  it("waits for its answer, which it gives with its own instructions", async () => {
    const { told, asked } = await ask("About 14 months as of 30 Sep, at £85k a month.");
    expect(asked).toContain("You are Analyst, Portfolio analysis");
    expect(asked).toContain("Always state the as-of date.");
    expect(asked).toContain("for Sara");
    expect(told).toContain("Analyst says:");
    expect(told).toContain("About 14 months");
    expect(await getTaskByNumber(ORG, 1)).toBeNull();
  });

  it("turns a question that needs longer into a task for it", async () => {
    const { told } = await ask("NEEDS_TASK: a full cash model across the entities");
    expect(told).toContain("it's now task #1");
    const task = (await getTaskByNumber(ORG, 1))!;
    expect(task).toMatchObject({ title: "Work out the cash runway", visibility: "private" });
    expect(task.members.map((m) => m.name)).toEqual(["Sara", "Analyst"]);
  });
});
