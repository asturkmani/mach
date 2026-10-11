import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setReviewScheduler, setScheduler } from "@/lib/agents/dispatch";
import { workerAgent } from "@/lib/agents/store";
import { setDecider, type Question } from "@/lib/ai/decide";
import { getCompanySkill, saveCompanySkill } from "@/lib/company-skills";
import { getDb } from "@/lib/db";
import { setLearnerModel } from "@/lib/learning/learner";
import { pendingProposals } from "@/lib/learning/proposals";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { loadProfile } from "@/lib/profile/store";
import { setSandboxProvider } from "@/lib/sandbox";
import { getTask, listInbox } from "@/lib/tasks";
import { createTaskWithTeam, replyToTask, setStatus } from "@/lib/work";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

/** The gate answers as told: "nothing" this likely, every yes-or-no signal that likely. */
function gateSays(nothing: number, signals = 0.1) {
  const states: string[] = [];
  setDecider(async (state, questions: Record<string, Question>) => {
    states.push(state);
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, q]) =>
        q.type === "choice"
          ? [id, { type: "choice", choice: nothing > 0.5 ? "nothing" : "workflow_skill", probabilities: { nothing, workflow_skill: 1 - nothing } }]
          : [id, { type: "boolean", probability: signals }],
      ),
    );
    return { answers, model: "typesafe-ai/jev" } as never;
  });
  return states;
}

describe("learning on the job", () => {
  let work: (() => Promise<void>)[];
  let reviews: (() => Promise<void>)[];
  const drain = async () => {
    while (work.length || reviews.length) await (work.shift() ?? reviews.shift())!();
  };

  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    work = [];
    reviews = [];
  });
  afterEach(() => {
    setScheduler(null);
    setReviewScheduler(null);
    setDecider(null);
    setLearnerModel(null);
    setSandboxProvider(null);
  });

  async function round(worker: Step[]) {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    setScheduler((job) => work.push(job), { model: scriptedModel(worker), research: false });
    setReviewScheduler((job) => reviews.push(job));
    setSandboxProvider(fakeSandboxes().provider);
    const by = { name: "Sara", personId: sara.id };
    const task = await createTaskWithTeam(ORG, {
      title: "Tag this week's Masttro transactions",
      agentIds: [(await workerAgent(ORG)).id],
      by,
    });
    await drain();
    return { sara, by, task, actor: { organizationId: ORG, personId: sara.id, name: "Sara", userId: "user_sara", isAdmin: false } };
  }

  it("reviews a round when it closes, and sends what's worth keeping to the person, applied on their yes", async () => {
    const { sara, by, task, actor } = await round([
      [["run_command", { command: "python pull_untagged.py" }]],
      [["finish", { summary: "Tagged 20 transactions.", report: "Tagged 20; 3 for Rita." }]],
    ]);
    const states = gateSays(0.2, 0.8);
    const learner = scriptedModel([
      [
        [
          "propose_change",
          {
            target: "skill",
            skill: "masttro-weekly-tagging",
            new: true,
            kind: "workflow",
            description: "Weekly: tag untagged Masttro transactions and route them for review",
            body: "## Steps\n1. Pull the untagged.\n## Rules\n- The Daher Family Trust goes to Rita.",
            why: "Rita said the Daher Family Trust is hers too, so it goes on her list.",
            cites: ["M2", "S1"],
          },
        ],
      ],
      [
        [
          "propose_change",
          { target: "profile", section: "How We Work", content: "Rita looks after the Daher Family Trust.", why: "Rita looks after the Daher Family Trust.", cites: ["M2"] },
        ],
      ],
      "Proposed a new tagging skill and a profile fact.",
    ]);
    setLearnerModel(learner);

    // Nothing is reviewed until the round closes: here, Sara replies on the result.
    expect(reviews).toHaveLength(0);
    await replyToTask(ORG, task.id, by, "Good. Rita looks after the Daher Family Trust too, so those go to her.");
    expect(reviews).toHaveLength(1);
    await drain();

    // The gate read a run record: the request, the steps and what Sara said, with ids to cite.
    expect(states[0]).toContain("Tag this week's Masttro transactions");
    expect(states[0]).toMatch(/S1 run_command: Running python pull_untagged\.py \(exit 0\)/);
    expect(states[0]).toContain("M1 Worker [result]: Tagged 20; 3 for Rita.");
    expect(states[0]).toContain("M2 Sara (person) [comment]: Good. Rita looks after the Daher Family Trust too");
    expect(JSON.stringify(learner.doGenerateCalls[0].prompt)).toContain("Patch, don't rewrite");

    const pending = await pendingProposals(ORG, sara.id);
    expect(pending.map((p) => [p.number, p.why])).toEqual([
      [1, "Rita said the Daher Family Trust is hers too, so it goes on her list."],
      [2, "Rita looks after the Daher Family Trust."],
    ]);
    // One message, a card in her Needs you.
    const card = (await getTask(ORG, pending[0].messageTaskId!))!;
    expect(card).toMatchObject({ kind: "suggestion", status: "review", options: [{ label: "Apply all" }, { label: "Skip all" }] });
    expect((await listInbox(ORG, sara.id)).map((t) => t.id)).toContain(card.id);
    // Nothing is applied before she says so.
    expect(await getCompanySkill(ORG, "masttro-weekly-tagging")).toBeNull();

    // Her answer, in her words, becomes actions: "just 1", then skip the other.
    expect(await doAction(actor, "skill.apply_proposal", { numbers: [1] })).toBe("Applied 1 (masttro-weekly-tagging (version 1)).");
    const skill = (await getCompanySkill(ORG, "masttro-weekly-tagging", { viewer: sara.id }))!;
    expect(skill).toMatchObject({ ownerPersonId: sara.id, visibility: "private", version: 1 });
    expect(await doAction(actor, "skill.skip_proposal", {})).toBe("Skipped 2.");
    expect(await loadProfile(ORG)).not.toContain("Rita looks after the Daher Family Trust.");
    expect((await getTask(ORG, card.id))!.status).toBe("done");
    const [review] = await getDb().query<{ learner_ran: boolean; gate_model: string }>("select learner_ran, gate_model from learning_reviews");
    expect(review).toEqual({ learner_ran: true, gate_model: "typesafe-ai/jev" });
  });

  it("stops at the gate when there's nothing to learn, and reviews each round once", async () => {
    const { by, task } = await round([[["finish", { summary: "Done.", report: "Done." }]]]);
    gateSays(0.95, 0.1);
    const learner = scriptedModel(["Nothing."]);
    setLearnerModel(learner);
    await setStatus(ORG, task.id, "done", by);
    await drain();
    expect(learner.doGenerateCalls).toHaveLength(0);
    const rows = await getDb().query<{ learner_ran: boolean; outcome: string }>("select learner_ran, outcome from learning_reviews");
    expect(rows).toEqual([{ learner_ran: false, outcome: "The gate found nothing to learn." }]);
    // Marking it done again, with no new runs, reviews nothing.
    await setStatus(ORG, task.id, "review", by);
    await setStatus(ORG, task.id, "done", by);
    await drain();
    expect(await getDb().query("select 1 from learning_reviews")).toHaveLength(1);
  });

  it("checks every change the learner drafts: it cites the run, holds no secrets, and a rule comes from a person", async () => {
    const { by, task, sara } = await round([[["finish", { summary: "Done.", report: "Done." }]]]);
    gateSays(0.1, 0.9);
    const body = { target: "skill", skill: "month-end", new: true, kind: "workflow", description: "Monthly close", body: "Steps" };
    const learner = scriptedModel([
      [["propose_change", { ...body, why: "x", cites: ["M9"] }]],
      [["propose_change", { ...body, body: "Use api_key = sk-live-abcdefghijklmnopqrstuvwx", why: "x", cites: ["S1"] }]],
      [["propose_change", { ...body, why: "x", cites: ["S1"] }]],
      "Nothing passed.",
    ]);
    setLearnerModel(learner);
    await setStatus(ORG, task.id, "done", by);
    await drain();
    const said = learner.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(said[1]).toContain("Not proposed: M9 isn't in the run record.");
    expect(said[2]).toContain("Not proposed: it looks like it holds a credential.");
    expect(said[3]).toContain("Not proposed: a change to how the company works has to come from something a person said");
    expect(await pendingProposals(ORG, sara.id)).toEqual([]);
  });

  it("lets the person the work was for apply what was learned about a system, and keeps the company's own ways for an admin", async () => {
    const { by, task, actor } = await round([[["finish", { summary: "Done.", report: "Done." }]]]);
    await saveCompanySkill(ORG, { name: "masttro", kind: "integration", description: "How Masttro works", body: "GET /v1/positions", by: { name: "Mach1" } });
    await saveCompanySkill(ORG, { name: "month-end", description: "Monthly close", body: "Steps", by: { name: "Admin" } });
    gateSays(0.1, 0.9);
    setLearnerModel(
      scriptedModel([
        [["propose_change", { target: "skill", skill: "masttro", body: "GET /v1/positions pages by cursor.", why: "Masttro pages by cursor.", cites: ["S1"] }]],
        [["propose_change", { target: "skill", skill: "month-end", body: "Steps, then reconcile.", why: "Reconcile after the steps.", cites: ["M2"] }]],
        "Two changes.",
      ]),
    );
    await replyToTask(ORG, task.id, by, "Thanks. For month-end, reconcile after the steps.");
    await drain();
    expect(await doAction(actor, "skill.apply_proposal", {})).toBe(
      "Applied 1 (masttro (version 2)). Not done: 2: Only an admin can change the company's month-end.",
    );
    expect((await getCompanySkill(ORG, "masttro"))!.body).toBe("GET /v1/positions pages by cursor.");
    expect((await getCompanySkill(ORG, "month-end"))!.version).toBe(1);
  });

  it("revises changes from the person's words, and applies all from the card's button", async () => {
    const { sara, by, task, actor } = await round([[["finish", { summary: "Done.", report: "Done." }]]]);
    gateSays(0.1, 0.9);
    const learner = scriptedModel([
      [["propose_change", { target: "profile", section: "Goals", content: "Grow the trust and the LLC.", why: "The trust and the LLC are this year's focus.", cites: ["M2"] }]],
      "One change.",
      // Revised from what Sara said.
      [["propose_change", { target: "profile", section: "Goals", content: "Grow the trust.", why: "The trust is this year's focus.", cites: ["M2"] }]],
      "Revised.",
    ]);
    setLearnerModel(learner);
    await replyToTask(ORG, task.id, by, "The trust and the LLC are our focus this year.");
    await drain();
    const [first] = await pendingProposals(ORG, sara.id);

    expect(await doAction(actor, "skill.revise_proposal", { words: "yes, but only the trust, not the LLC" })).toMatch(/^I'll revise them as you said/);
    await drain();
    expect(JSON.stringify(learner.doGenerateCalls.at(-2)!.prompt)).toContain('The person answered: \\"yes, but only the trust, not the LLC\\"');
    const [revised] = await pendingProposals(ORG, sara.id);
    expect(revised.why).toBe("The trust is this year's focus.");
    expect(revised.messageTaskId).not.toBe(first.messageTaskId);
    expect((await getTask(ORG, first.messageTaskId!))!.status).toBe("done");

    const card = (await getTask(ORG, revised.messageTaskId!))!;
    expect(await doAction(actor, "task.pick_option", { task: card.number, option: "Apply all" })).toBe("Applied 1 (the profile's Goals).");
    expect(await loadProfile(ORG)).toContain("Grow the trust.");
  });
});
