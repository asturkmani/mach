import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { listTaskFiles, saveVersion } from "@/lib/files";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask, getTask, listMessages, setPendingLogin } from "@/lib/tasks";
import { MAX_REPLY_ATTACHMENTS, replyToTask, WorkError } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const CSV = "entity,value\nCedar Holdings,1200000\n";

/** What the model was sent on its first call: the system text and the opening message's parts. */
function firstCall(model: ReturnType<typeof scriptedModel>) {
  const prompt = model.doGenerateCalls[0].prompt;
  const system = prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const user = prompt.find((m) => m.role === "user")!;
  return { system, parts: Array.isArray(user.content) ? user.content : [] };
}

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const analyst = await createAgent(ORG, { name: "Analyst" });
  const task = await createTask(ORG, { title: "Reconcile Q3 valuations", people: [ahmed.id], agents: [analyst.id] });
  return { ahmed, analyst, task, by: { name: "Ahmed", personId: ahmed.id } };
}

describe("attachments in a task's thread", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("adds attached files to the job as inputs, and the agent sees them in its sandbox and the images themselves", async () => {
    const { analyst, task, by } = await setUp();
    const seen: { csv?: string } = {};
    const sandboxes = fakeSandboxes({
      "look.py": () => ({ stdout: "ok" }),
      "check.py": (files) => {
        seen.csv = files.get("/vercel/job/inputs/q3.csv")?.toString();
        return { stdout: "read it" };
      },
    });
    setSandboxProvider(sandboxes.provider);

    // The job's sandbox already exists from an earlier run.
    await runAgentOnTask(ORG, task.id, analyst.id, {
      research: false,
      model: scriptedModel([
        [["run_code", { filename: "look.py", language: "python", code: "print('ok')" }]],
        [["ask", { question: "Which file has the Q3 numbers?" }]],
      ]),
    });

    // Ahmed answers with a screenshot and a CSV, and no text.
    const screenshot = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#2a6" } }).png().toBuffer();
    const model = scriptedModel([
      [["run_code", { filename: "check.py", language: "python", code: "print(open('inputs/q3.csv').read())" }]],
      [["finish", { summary: "Q3 reconciled.", report: "Matched the screenshot to q3.csv." }]],
    ]);
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), { research: false, model });
    await replyToTask(ORG, task.id, by, "", [
      { name: "screenshot.png", bytes: screenshot },
      { name: "q3.csv", bytes: Buffer.from(CSV) },
    ]);
    await Promise.all(runs);

    // The message carries the files; they're on the job as inputs.
    const message = (await listMessages(task.id)).find((m) => m.personId && m.attachments.length)!;
    expect(message.body).toBe("");
    expect(message.attachments.map((a) => [a.name, a.contentType])).toEqual([
      ["q3.csv", "text/csv"],
      ["screenshot.png", "image/png"],
    ]);
    const files = await listTaskFiles(ORG, task.id);
    expect(files.filter((f) => f.role === "input").map((f) => f.name).sort()).toEqual(["q3.csv", "screenshot.png"]);

    // The agent was woken: its brief notes the attachments, it saw the image (scaled down), and the
    // CSV was copied into the sandbox that already existed.
    const { system, parts } = firstCall(model);
    expect(system).toContain("[attached: q3.csv (text/csv");
    const image = parts.find((p) => p.type === "file");
    expect(image).toMatchObject({ mediaType: "image/jpeg" });
    const data = (image as { data: { type: "data"; data: string } }).data.data;
    const size = await sharp(Buffer.from(data, "base64")).metadata();
    expect(Math.max(size.width!, size.height!)).toBe(1568);
    expect(seen.csv).toBe(CSV);
    expect(sandboxes.log.filter((l) => l.startsWith("create"))).toHaveLength(1);
    expect((await getTask(ORG, task.id))!.status).toBe("review");

    // The next run doesn't get the image again: the agent has spoken since.
    const later = scriptedModel([[["finish", { summary: "Done.", report: "Done." }]]]);
    setScheduler((work) => runs.push(work()), { research: false, model: later });
    await replyToTask(ORG, task.id, by, "Thanks, one more check please.");
    await Promise.all(runs);
    expect(firstCall(later).parts.filter((p) => p.type === "file")).toEqual([]);
  });

  it("makes a re-attached deliverable its next version, copied over the sandbox's copy", async () => {
    const { analyst, task, by } = await setUp();
    const sandboxes = fakeSandboxes({ "look.py": () => ({ stdout: "ok" }) });
    setSandboxProvider(sandboxes.provider);
    await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("v1"), taskId: task.id, agentId: analyst.id });
    await runAgentOnTask(ORG, task.id, analyst.id, {
      research: false,
      model: scriptedModel([
        [["run_code", { filename: "look.py", language: "python", code: "print('ok')" }]],
        [["ask", { question: "Does the model look right?" }]],
      ]),
    });
    expect(sandboxes.file(`mach-task-${task.id}`, "outputs/model.xlsx")?.toString()).toBe("v1");

    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), {
      research: false,
      model: scriptedModel([
        [["run_code", { filename: "look.py", language: "python", code: "print('ok')" }]],
        [["finish", { summary: "Used your edits.", report: "Done." }]],
      ]),
    });
    await replyToTask(ORG, task.id, by, "I fixed the growth rate", [{ name: "model.xlsx", bytes: Buffer.from("v2 from Ahmed") }]);
    await Promise.all(runs);

    const model = (await listTaskFiles(ORG, task.id)).find((f) => f.name === "model.xlsx")!;
    expect(model.role).toBe("output");
    expect(model.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(sandboxes.file(`mach-task-${task.id}`, "outputs/model.xlsx")?.toString()).toBe("v2 from Ahmed");
  });

  it("needs text or a file, caps how many files, and never takes an attachment for a sign-in code", async () => {
    const { task, by } = await setUp();
    setScheduler(() => undefined);
    await expect(replyToTask(ORG, task.id, by, "  ")).rejects.toBeInstanceOf(WorkError);
    const many = Array.from({ length: MAX_REPLY_ATTACHMENTS + 1 }, (_, i) => ({ name: `f${i}.txt`, bytes: Buffer.from("x") }));
    await expect(replyToTask(ORG, task.id, by, "", many)).rejects.toThrow(/at most/);

    await setPendingLogin(task.id, "masttro-web");
    await replyToTask(ORG, task.id, by, "123456", [{ name: "code.png", bytes: Buffer.from("not really a png") }]);
    const last = (await listMessages(task.id)).at(-1)!;
    expect(last.body).toBe("123456");
    expect(last.attachments.map((a) => a.name)).toEqual(["code.png"]);
  });
});
