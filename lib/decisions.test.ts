import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as decideRoute } from "@/app/api/decide/route";
import { POST as outcomeRoute } from "@/app/api/decide/outcome/route";
import { MACH_PY } from "@/lib/agents/mach-helper";
import { startSandbox } from "@/lib/agents/sandbox-steps";
import { setDecider, type Question } from "@/lib/ai/decide";
import { backtest, decideForSkill, NONE, nearest, readRunToken, recordOutcome, runToken } from "@/lib/decisions";
import { createOrganization } from "@/lib/orgs";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask } from "@/lib/tasks";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";

/** Jev answers as told, and remembers what it was asked. */
function jev(choice: string, probability: number) {
  const asked: { state: string; questions: Record<string, Question> }[] = [];
  setDecider(async (state, questions) => {
    asked.push({ state, questions });
    return {
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, q]) =>
          q.type === "choice" ? [id, { type: "choice", choice, probabilities: { [choice]: probability } }] : [id, { type: "boolean", probability }],
        ),
      ),
      model: "typesafe-ai/jev",
    } as never;
  });
  return asked;
}

describe("decisions inside skills (mach.decide)", () => {
  let taskId: string;
  beforeEach(async () => {
    vi.stubEnv("MACH_SECRETS_KEY", Buffer.alloc(32, 7).toString("base64"));
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    taskId = (await createTask(ORG, { title: "Weekly tagging" })).id;
  });
  afterEach(() => {
    setDecider(null);
    setSandboxProvider(null);
    vi.unstubAllEnvs();
  });

  it("applies nothing automatically until people's answers show it can, then only above the backtested threshold", async () => {
    const tag = { instructions: "Which tag fits?", options: ["Rent", "Fees", "Salary"] };
    jev("Rent", 0.95);
    const first = await decideForSkill(ORG, taskId, { skill: "masttro-weekly-tagging", state: "ACME LTD, monthly, matches last 3", questions: { tag }, key: "ACME LTD", target: 0.98 });
    expect(first.tag).toMatchObject({ choice: "Rent", probability: 0.95, auto: false, threshold: null });

    // 25 answers people judged: right every time Jev was at least 0.9 sure, wrong below.
    for (let i = 0; i < 25; i++) {
      const sure = i < 20 ? 0.9 + i * 0.004 : 0.6;
      jev("Rent", sure);
      const { tag: d } = await decideForSkill(ORG, taskId, { skill: "masttro-weekly-tagging", state: `ACME LTD payment ${i}`, questions: { tag }, key: "ACME LTD" });
      await recordOutcome(ORG, d.id, sure >= 0.9 ? "Rent" : "Fees", "Rita");
    }
    jev("Rent", 0.95);
    const sure = await decideForSkill(ORG, taskId, { skill: "masttro-weekly-tagging", state: "ACME LTD again", questions: { tag }, key: "ACME LTD", target: 0.98 });
    expect(sure.tag.auto).toBe(true);
    expect(sure.tag.threshold).toBeCloseTo(0.9, 5);
    jev("Rent", 0.7);
    expect((await decideForSkill(ORG, taskId, { skill: "masttro-weekly-tagging", state: "ACME LTD, odd amount", questions: { tag }, target: 0.98 })).tag.auto).toBe(false);
  });

  it("puts the closest past cases and their final answers in the state, and always offers none of these", async () => {
    const asked = jev("Rent", 0.8);
    const tag = { instructions: "Which tag fits?", options: { Rent: "Property", Fees: null } };
    const { tag: d } = await decideForSkill(ORG, taskId, { skill: "tagging", state: "ACME LTD, 1,200 monthly", questions: { tag }, key: "ACME LTD" });
    await recordOutcome(ORG, d.id, "Fees", "Rita");
    await decideForSkill(ORG, taskId, { skill: "tagging", state: "ACME LTD, 1,200 monthly", questions: { tag }, key: "ACME LTD" });
    expect(asked[1].state).toContain("Past cases and the answers that stood:\n- ACME LTD: ACME LTD, 1,200 monthly → tag: Fees");
    expect(Object.keys((asked[1].questions.tag as { criteria: object }).criteria)).toEqual(["Rent", "Fees", NONE]);
  });

  it("narrows more options than Jev takes to the likely ones", async () => {
    const asked = jev("T7", 0.8);
    const options = Array.from({ length: 400 }, (_, i) => `T${i}`);
    await decideForSkill(ORG, taskId, { skill: "tagging", state: "x", questions: { tag: { type: "choice", instructions: "Which?", options } } });
    expect(Object.keys((asked[0].questions.tag as { criteria: object }).criteria)).toHaveLength(255);
  });

  it("finds alike cases by key first, then by words, and backtests only on enough judged answers", () => {
    const past = [
      { state: "Salary for October", key: "Payroll Co", final: "Salary", choice: "Salary", probability: 0.9, outcome: "confirmed" },
      { state: "ACME LTD rent October", key: "ACME LTD", final: "Rent", choice: "Rent", probability: 0.9, outcome: "confirmed" },
      { state: "Office rent October", key: "Landlord", final: "Rent", choice: "Rent", probability: 0.9, outcome: "confirmed" },
    ];
    expect(nearest(past, "ACME LTD rent November", "ACME LTD", 2).map((p) => p.key)).toEqual(["ACME LTD", "Landlord"]);
    expect(backtest([{ probability: 0.99, correct: true }], 0.98)).toBeNull();
  });

  it("answers only a job's scripts, by the token the sandbox adds, and records what people decided", async () => {
    jev("Rent", 0.9);
    const post = (route: typeof decideRoute, body: object, token?: string) =>
      route(new Request("https://mach.example/api/decide", { method: "POST", headers: token ? { "x-mach-run": token } : {}, body: JSON.stringify(body) }));
    const body = { skill: "tagging", state: "ACME LTD", questions: { tag: { instructions: "Which tag?", options: ["Rent", "Fees"] } } };
    expect((await post(decideRoute, body)).status).toBe(401);
    expect((await post(decideRoute, body, runToken(ORG, taskId) + "x")).status).toBe(401);
    const token = runToken(ORG, taskId);
    expect(readRunToken(token)).toEqual({ organizationId: ORG, taskId });
    expect(readRunToken(runToken(ORG, taskId, Date.now() - 13 * 60 * 60_000))).toBeNull();
    const answered = (await (await post(decideRoute, body, token)).json()) as { answers: { tag: { id: string; choice: string } } };
    expect(answered.answers.tag.choice).toBe("Rent");
    const recorded = await post(outcomeRoute, { id: answered.answers.tag.id, final: "Fees", by: "Rita" }, token);
    expect(await recorded.json()).toEqual({ outcome: "changed" });
  });

  it("ships a mach module scripts can import", () => {
    const python = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: MACH_PY, encoding: "utf8" });
    if (python.error) return; // no Python here
    expect(python.status).toBe(0);
    expect(MACH_PY).toContain("def decide(skill, state, questions, key=None, target=None):");
  });

  it("gives a job's sandbox the mach module, and signs its requests to Mach1 with the job's token", async () => {
    vi.stubEnv("APP_URL", "https://mach.example");
    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    await startSandbox({ organizationId: ORG, taskId, agentId: null, agentName: "Worker" });
    const name = `mach-task-${taskId}`;
    expect(sandboxes.file(name, "/vercel/job/.mach/mach.py")?.toString()).toBe(MACH_PY);
    const policy = sandboxes.machines.get(name)!.policies.at(-1) as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> };
    expect(readRunToken(policy.allow["mach.example"][0].transform[0].headers["x-mach-run"])).toEqual({ organizationId: ORG, taskId });
  });
});
