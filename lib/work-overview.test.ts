import { beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffInstructions, createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent, listAgents } from "@/lib/agents/store";
import { getOrganization, createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { saveSchedule } from "@/lib/schedules";
import { addMessage, claimRun, createTask, findTasks, getTask, listMessages, listTasks, renewRun } from "@/lib/tasks";
import { listScheduledJobs, taskState, workOverview } from "@/lib/work-overview";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const analyst = await createAgent(ORG, { name: "Analyst", role: "Financial analysis" });
  const review = await createTask(ORG, { title: "Review Micron earnings", people: [ahmed.id], agents: [analyst.id], status: "ready" });
  const tagging = await createTask(ORG, { title: "Tag cash transactions", people: [ahmed.id], status: "waiting", summary: "Which account is the Apple dividend in?" });
  const refresher = await createAgent(ORG, { kind: "worker", name: "Family wealth refresh worker", role: "Family wealth refresh" });
  const refresh = await createTask(ORG, { title: "Refresh page: Family wealth", agents: [refresher.id], status: "done" });
  await saveSchedule(refresh.id, { cron: "0 7 * * 1-5", timezone: "Europe/London", mode: "script", quiet: true });
  return { ahmed, analyst, review, tagging, refresher, refresh };
}

describe("the Chief of Staff's view of the work", () => {
  beforeEach(async () => {
    setScheduler(() => {});
    await useTestDb();
  });

  it("sees every open task with what's happening on it, every agent, and the scheduled jobs", async () => {
    const { analyst, review } = await setUp();
    await claimRun(ORG, review.id, analyst.id, "Reading the task");
    await renewRun(review.id, analyst.id, "Running summarise.py");
    const [organization, agents, openTasks, jobs] = await Promise.all([getOrganization(ORG), listAgents(ORG), listTasks(ORG, { closedLimit: 0 }), listScheduledJobs(ORG)]);

    const overview = workOverview({ openTasks, agents, jobs });
    expect(overview).toContain("#1 Review Micron earnings [in_progress; Analyst is working on it (0m): Running summarise.py] · Ahmed, Analyst");
    expect(overview).toContain("#2 Tag cash transactions [waiting; waiting on people] · Ahmed\n  Which account is the Apple dividend in?");
    expect(overview).toContain("- Analyst (Financial analysis): #1 (working on it now)");
    expect(overview).toContain("- Family wealth refresh worker: fixes scheduled job #3 when it breaks");
    expect(overview).toMatch(/#3 Refresh page: Family wealth: At 07:00, Monday through Friday \(Europe\/London\), replays its script.*fine; agent: Family wealth refresh worker/);
    // The scheduled job isn't listed again among the open tasks.
    expect(overview.split("Defined agents")[0]).not.toContain("Refresh page");

    const instructions = chiefOfStaffInstructions({ organization: { ...organization!, onboardingCompletedAt: new Date() }, user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" }, profile: "", agents, openTasks, jobs });
    expect(instructions).toContain("You see all of it");
    expect(instructions).toContain("Running summarise.py");
    expect(taskState((await getTask(ORG, review.id))!)).toMatch(/^Analyst is working on it/);
  });

  it("finds work by words in the thread, status or who's on it, finished work included when asked", async () => {
    const { tagging, review } = await setUp();
    await addMessage(tagging.id, { author: "Ahmed", kind: "comment", body: "The dividend is in the HSBC account" });
    expect((await findTasks(ORG, { query: "HSBC" })).map((t) => t.number)).toEqual([tagging.number]);
    expect((await findTasks(ORG, { member: "analyst" })).map((t) => t.number)).toEqual([review.number]);
    expect((await findTasks(ORG, { query: "Refresh page" })).map((t) => t.number)).toEqual([]);
    expect((await findTasks(ORG, { query: "Refresh page", includeClosed: true })).map((t) => t.number)).toEqual([3]);
    expect((await findTasks(ORG, { status: "waiting" })).map((t) => t.number)).toEqual([tagging.number]);
  });

  it("reads a task and replies on it as the person, which wakes its agent", async () => {
    const { ahmed, review } = await setUp();
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const model = scriptedModel([
      [["read_task", { number: 1 }]],
      [["reply_on_task", { number: 1, message: "Use the Q3 numbers, not Q2." }]],
      "Done: I told the Analyst on #1 to use the Q3 numbers.",
    ]);
    const agent = createChiefOfStaff({ organization, user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" }, person: ahmed, profile: "" }, { model, research: false });
    const result = await agent.generate({ prompt: "Tell the analyst on the Micron review to use Q3 numbers" });

    expect(result.text).toContain("Q3");
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("#1 Review Micron earnings");
    const thread = await listMessages(review.id);
    expect(thread.at(-1)).toMatchObject({ author: "Ahmed", personId: ahmed.id, body: "Use the Q3 numbers, not Q2." });
    expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain("Posted on #1.");
  });
});
