import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { effectOf, preApproves } from "@/lib/agents/gates";
import { runAgentOnTask } from "@/lib/agents/runner";
import { workerAgent } from "@/lib/agents/store";
import { approvalsFor } from "@/lib/approvals";
import { getDb } from "@/lib/db";
import { saveCredentials, saveIntegration } from "@/lib/integrations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { createTask, getTask } from "@/lib/tasks";
import { doAction } from "@/test/do-action";
import { useTestDb } from "@/test/db";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";

describe("gates on changes outside Mach1", () => {
  beforeEach(async () => {
    setScheduler(() => {});
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => {
    setScheduler(null);
    vi.unstubAllGlobals();
  });

  it("know what each tool call touches, and what a pre-approval covers", () => {
    expect(effectOf("call_api", { integration: "masttro", path: "/v1/tags" })).toEqual({ external: false });
    expect(effectOf("call_api", { integration: "masttro", method: "POST", path: "/v1/tags" })).toMatchObject({ external: true, what: "POST /v1/tags on masttro" });
    expect(effectOf("use_browser", { task: "Look up the balance" })).toEqual({ external: false });
    expect(effectOf("use_browser", { task: "Enter the tags", changes: true })).toMatchObject({ external: true });
    const pr = effectOf("github_api", { method: "POST", path: "/repos/cedar/site/pulls" });
    const merge = effectOf("github_api", { method: "PUT", path: "/repos/cedar/site/pulls/7/merge" });
    expect(pr.external && preApproves("github:POST:/repos/*/*/pulls", pr)).toBe(true);
    expect(merge.external && preApproves("github:POST:/repos/*/*/pulls", merge)).toBe(false);
    const post = effectOf("call_api", { integration: "masttro", method: "POST", path: "/v1/tags/4411" });
    expect(post.external && preApproves("api:masttro:POST:/v1/tags", post)).toBe(true);
    expect(post.external && preApproves("api:other:POST:/v1/tags", post)).toBe(false);
  });

  it("let a worker change a system only under an approval of exactly that change, each item once", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const masttro = await saveIntegration(ORG, {
      kind: "api",
      name: "Masttro",
      config: { baseUrl: "https://api.masttro.example", domains: [], fields: [{ name: "key", label: "Key" }], headers: { "X-Key": "{{key}}" } },
      access: "write",
    });
    await saveCredentials(ORG, masttro.id, { key: "k-123" });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return Response.json({ ok: true });
      }),
    );
    const worker = await workerAgent(ORG);
    const task = await createTask(ORG, { title: "Tag this week's transactions", people: [sara.id], agents: [worker.id], createdBy: { personId: sara.id } });
    const tag = { integration: "masttro", method: "POST", path: "/v1/tags", body: { txn: 4411, tag: "Rent" } };
    const run = async (steps: Step[]) => {
      const model = scriptedModel(steps);
      await runAgentOnTask(ORG, task.id, worker.id, { model, research: false });
      return model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    };

    // No approval: refused before anything leaves Mach1. It asks for one, with the exact change.
    const first = await run([
      [["call_api", tag]],
      [["request_approval", { what: "Tag 1 transaction", items: ["Tag txn 4411 (ACME LTD, £1,200) as Rent"], summary: "Approve tagging 1 transaction?" }]],
    ]);
    expect(first[1]).toContain("Not done: POST /v1/tags on masttro changes something outside Mach1");
    expect(requests).toEqual([]);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "waiting", options: [{ label: "Approve" }, { label: "Change something" }] });

    // Sara approves (here from chat, as her Chief of Staff would): the change goes, once.
    const actor = { organizationId: ORG, personId: sara.id, name: "Sara", userId: "user_sara", isAdmin: false };
    await doAction(actor, "task.pick_option", { task: task.number, option: "Approve" });
    expect((await approvalsFor(ORG, task.id))[0]).toMatchObject({ status: "approved", approvedBy: "Sara", items: ["Tag txn 4411 (ACME LTD, £1,200) as Rent"] });
    const second = await run([
      [["call_api", { ...tag, approval: "A1", item: 1 }]],
      [["call_api", { ...tag, approval: "A1", item: 1 }]],
      [["call_api", { ...tag, approval: "A1", item: 2 }]],
      [["finish", { summary: "Tagged 1.", report: "Tagged txn 4411 as Rent." }]],
    ]);
    expect(requests).toEqual(["POST https://api.masttro.example/v1/tags"]);
    expect(second[2]).toContain("Not done: item 1 of A1 was already done.");
    expect(second[3]).toContain("Say which of A1's 1 items this is");
    const ledger = await getDb().query<{ item: number; tool: string }>("select item, tool from approval_uses");
    expect(ledger).toEqual([{ item: 1, tool: "call_api" }]);
  });

  it("let the coding skill open a pull request without asking, but not merge one", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const worker = await workerAgent(ORG);
    const task = await createTask(ORG, { title: "Fix the typo", people: [sara.id], agents: [worker.id], skills: ["coding-in-github"], createdBy: { personId: sara.id } });
    const model = scriptedModel([
      [["github_api", { method: "POST", path: "/repos/cedar/site/pulls", body: { title: "Fix typo" } }]],
      [["github_api", { method: "PUT", path: "/repos/cedar/site/pulls/7/merge" }]],
      [["finish", { summary: "Opened #7.", report: "Opened #7." }]],
    ]);
    await runAgentOnTask(ORG, task.id, worker.id, { model, research: false });
    const said = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    // The pull request went through to GitHub (which needs Sara connected); the merge was stopped at the gate.
    expect(said[1]).not.toContain("changes something outside Mach1");
    expect(said[2]).toContain("Not done: PUT /repos/cedar/site/pulls/7/merge on GitHub changes something outside Mach1");
  });

  it("keep the chat agent from changing systems itself: that goes through a worker and its approval", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const model = scriptedModel([[["github_api", { method: "PUT", path: "/repos/cedar/site/pulls/7/merge" }]], "OK."]);
    await createChiefOfStaff(
      { organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person: (await getPerson(ORG, sara.id))!, profile: "" },
      { model, research: false },
    ).generate({ prompt: "merge it" });
    expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).toContain("From chat, hand it to the Worker with spawn_worker");
  });
});
