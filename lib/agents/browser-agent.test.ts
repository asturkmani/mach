import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { runBrowserAgent, setBrowserAgentModel, withoutOldScreenshots } from "@/lib/agents/browser-agent";
import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { sandboxUser } from "@/lib/agents/toolkit";
import { getBrowserSession } from "@/lib/browser-sessions";
import { listTaskFiles } from "@/lib/files";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { saveCredentials, saveIntegration } from "@/lib/integrations";
import { createTask, getTask, listMessages } from "@/lib/tasks";
import { replyToTask } from "@/lib/work";
import { getDb } from "@/lib/db";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

/** A tiny cash ledger web app, faked behind the browser agent's step script. */
async function ledgerSandboxes() {
  const png = await sharp({ create: { width: 64, height: 40, channels: 3, background: "#fff" } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const site = { tagged: "" as string, commands: [] as Record<string, unknown>[] };
  const LOGINS = "/vercel/job/.logins";
  const sandboxes = fakeSandboxes({
    // The sign-in helper: Masttro wants a code the first time.
    "login.py": (files) => {
      for (const path of [...files.keys()].filter((p) => p.startsWith("/tmp/mach-login-"))) files.delete(path);
      files.set(`${LOGINS}/masttro-web.status`, Buffer.from("needs_code"));
    },
    "login-wait.sh": (files) => {
      const code = files.get(`${LOGINS}/masttro-web.code`)?.toString();
      if (code) {
        files.delete(`${LOGINS}/masttro-web.code`);
        files.set(`${LOGINS}/masttro-web.json`, Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "s" }] })));
        files.set(`${LOGINS}/masttro-web.status`, Buffer.from(code === "123456" ? "ok" : "failed: wrong code"));
      }
      return { stdout: files.get(`${LOGINS}/masttro-web.status`)?.toString() ?? "starting" };
    },
    "browser-server.py": (files, args) => {
      files.set(args[2], Buffer.from("123"));
    },
    "browser-step.py": (files, [input, output, shot]) => {
      const command = JSON.parse(files.get(input)!.toString()) as Record<string, unknown> & { type: string };
      site.commands.push(command);
      const result: Record<string, unknown> = { url: "https://ledger.example/cash", title: "Cash", actions: [] };
      if (command.type === "act") {
        for (const a of command.actions as { do: string; text?: string }[]) {
          if (a.do === "type") site.tagged = a.text ?? "";
          (result.actions as unknown[]).push({ do: a.do, ok: true });
        }
      }
      if (command.type === "read") result.read = [{ kind: "button", label: "Save tag", x: 600, y: 300 }];
      if (command.type === "evidence") {
        files.set(command.path as string, png);
        result.saved = command.path;
      }
      files.set(output, Buffer.from(JSON.stringify(result)));
      files.set(shot, jpeg);
    },
  });
  return { sandboxes, site };
}

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const clerk = await createAgent(ORG, { name: "Cash tagger", role: "Cash tagging" });
  const task = await createTask(ORG, { title: "Tag last week's cash transactions", people: [ahmed.id], agents: [clerk.id] });
  return { ahmed, clerk, task };
}

describe("the browser agent", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    setBrowserAgentModel(null);
    await useTestDb();
  });

  it("keeps only the latest screenshots in the conversation", () => {
    const shot = (id: string) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: id,
          toolName: "look",
          output: {
            type: "content" as const,
            value: [
              { type: "text" as const, text: `look ${id}` },
              { type: "file" as const, mediaType: "image/jpeg", data: { type: "data" as const, data: "AAAA" } },
            ],
          },
        },
      ],
    });
    const pruned = withoutOldScreenshots([shot("1"), shot("2"), shot("3")], 2);
    const images = pruned.map((m) => JSON.stringify(m).includes('"type":"file"'));
    expect(images).toEqual([false, true, true]);
    expect(JSON.stringify(pruned[0])).toContain("look 1");
    expect(JSON.stringify(pruned[0])).toContain("[older screenshot removed]");
  });

  it("does a job with screenshots, keeps evidence with the task's files, and carries on in the same session", async () => {
    const { clerk, task } = await setUp();
    const { sandboxes, site } = await ledgerSandboxes();
    setSandboxProvider(sandboxes.provider);
    const context = { organizationId: ORG, taskId: task.id, agentId: clerk.id, agentName: clerk.name };
    const using = sandboxUser(context, {});

    const first = scriptedModel([
      [["look", {}]],
      [["act", { actions: [{ do: "type", target: { label: "Tag" }, text: "Dividends" }, { do: "click", target: { role: "button", name: "Save tag" } }] }]],
      [["save_screenshot", { name: "Tagged transaction", caption: "The Apple dividend tagged as Dividends" }]],
      [["finish", { status: "done", message: "Tagged the 3 Oct Apple payment as Dividends; the ledger shows the tag." }]],
    ]);
    setBrowserAgentModel(first);
    const report = await runBrowserAgent(context, using, { task: "Tag the 3 Oct Apple payment as Dividends", start_url: "https://ledger.example/cash" }, { durable: true, logins: [] });

    expect(report).toMatchObject({ status: "done", message: expect.stringContaining("Dividends") });
    expect(site.tagged).toBe("Dividends");
    // The model saw a screenshot after its look and its act.
    const sawImages = first.doGenerateCalls.map((call) => JSON.stringify(call.prompt).includes("image/jpeg"));
    expect(sawImages).toEqual([false, true, true, true]);
    expect(report.evidence).toEqual([
      expect.objectContaining({ name: "tagged-transaction", caption: "The Apple dividend tagged as Dividends", versionId: expect.any(String), image: expect.any(String) }),
    ]);
    expect((await listTaskFiles(ORG, task.id)).map((f) => f.name)).toEqual(["screenshot-tagged-transaction.png"]);

    // Its history is kept, without screenshots, for the next message in the session.
    const saved = (await getBrowserSession(ORG, report.session, task.id))!;
    expect(saved.status).toBe("done");
    expect(JSON.stringify(saved.messages)).not.toContain("image/jpeg");

    const second = scriptedModel([[["finish", { status: "done", message: "The tag reads Dividends." }]]]);
    setBrowserAgentModel(second);
    const followUp = await runBrowserAgent(context, using, { session: report.session, message: "What does the tag say now?" }, { durable: false, logins: [] });
    expect(followUp).toMatchObject({ status: "done", session: report.session, message: "The tag reads Dividends." });
    const prompt = JSON.stringify(second.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Tag the 3 Oct Apple payment as Dividends");
    expect(prompt).toContain("What does the tag say now?");

    // Another task can't pick up this session.
    const other = await runBrowserAgent({ ...context, taskId: null }, using, { session: report.session, message: "hi" }, { durable: false, logins: [] });
    expect(other.status).toBe("failed");
  });

  it("is a tool workers use, and they see its screenshots", async () => {
    const { clerk, task } = await setUp();
    const { sandboxes } = await ledgerSandboxes();
    setSandboxProvider(sandboxes.provider);
    setBrowserAgentModel(
      scriptedModel([
        [["act", { actions: [{ do: "type", target: { label: "Tag" }, text: "Dividends" }] }]],
        [["save_screenshot", { name: "done", caption: "Tagged" }]],
        [["finish", { status: "done", message: "Tagged it." }]],
      ]),
    );
    const worker = scriptedModel([
      [["use_browser", { task: "Tag the Apple payment as Dividends", start_url: "https://ledger.example/cash" }]],
      [["finish", { summary: "Tagged the Apple payment.", report: "Tagged the Apple payment as Dividends (screenshot attached)." }]],
    ]);
    const outcome = await runAgentOnTask(ORG, task.id, clerk.id, { model: worker, research: false });

    expect(outcome).toEqual({ type: "finished" });
    const afterBrowser = JSON.stringify(worker.doGenerateCalls[1].prompt);
    expect(afterBrowser).toContain("Browser agent (session");
    expect(afterBrowser).toContain("Tagged it.");
    expect(afterBrowser).toContain("image/jpeg");
    expect((await listMessages(task.id)).at(-1)!.body).toContain("Tagged the Apple payment as Dividends");
  });

  it("asks the people on the task for a sign-in code, then signs in and carries on in the same session", async () => {
    const { ahmed, clerk, task } = await setUp();
    const login = await saveIntegration(ORG, {
      kind: "login",
      name: "Masttro (web)",
      slug: "masttro-web",
      config: { loginUrl: "https://app.masttro.example/login", domains: [], fields: [{ name: "username", label: "Username", secret: false }, { name: "password", label: "Password" }] },
      access: "write",
      agentIds: [clerk.id],
    });
    await saveCredentials(ORG, login.id, { username: "ahmed@cedar.example", password: "pw" });
    const { sandboxes, site } = await ledgerSandboxes();
    setSandboxProvider(sandboxes.provider);

    setBrowserAgentModel(
      scriptedModel([
        [["sign_in", { login: "masttro-web" }]],
        [["finish", { status: "needs_input", message: "Masttro wants a sign-in code.", question: "What's the Masttro code?" }]],
      ]),
    );
    const first = await runAgentOnTask(ORG, task.id, clerk.id, {
      research: false,
      model: scriptedModel([[["use_browser", { task: "Tag the Apple payment as Dividends in Masttro", login: "masttro-web" }]], "should not get here"]),
    });
    expect(first).toEqual({ type: "asked" });
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "waiting", pendingLogin: "masttro-web" });
    const [{ id: session }] = await getDb().query<{ id: string }>("select id from browser_sessions where task_id = $1", [task.id]);

    // Ahmed replies with the code; the worker carries on in the same browser session.
    setBrowserAgentModel(
      scriptedModel([
        [["sign_in", { login: "masttro-web" }]],
        [["act", { actions: [{ do: "type", target: { label: "Tag" }, text: "Dividends" }] }]],
        [["finish", { status: "done", message: "Signed in and tagged it." }]],
      ]),
    );
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), {
      research: false,
      model: scriptedModel([
        [["use_browser", { session, message: "The sign-in code has been given. Sign in and carry on." }]],
        [["finish", { summary: "Tagged in Masttro.", report: "Tagged the Apple payment as Dividends." }]],
      ]),
    });
    await replyToTask(ORG, task.id, { name: "Ahmed", personId: ahmed.id }, "123456");
    await Promise.all(runs);

    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", pendingLogin: null });
    expect(site.commands.map((c) => c.type)).toContain("import_state");
    expect(site.tagged).toBe("Dividends");
    expect(JSON.stringify(await listMessages(task.id))).not.toContain("123456");
  });
});
