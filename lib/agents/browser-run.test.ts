import { beforeEach, describe, expect, it } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { getIntegration, listIntegrations, readLogin, saveCredentials, saveIntegration } from "@/lib/integrations";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask, getTask, listMessages } from "@/lib/tasks";
import { replyToTask } from "@/lib/work";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const PASSWORD = "hunter2-masttro-pw";
const DIR = "/vercel/job/.logins";

/** Masttro's sign-in, faked: it wants a code the first time, then remembers the browser. */
function masttroSandboxes() {
  const seen: { creds?: Record<string, unknown> } = {};
  const sandboxes = fakeSandboxes({
    "login.py": (files) => {
      const path = [...files.keys()].find((p) => p.startsWith("/tmp/mach-login-"))!;
      seen.creds = JSON.parse(files.get(path)!.toString());
      files.delete(path);
      const remembered = files.get(`${DIR}/masttro-web.json`)?.toString().includes("remembered");
      files.set(`${DIR}/masttro-web.status`, Buffer.from(remembered ? "ok" : "needs_code"));
    },
    // The helper waiting for the code, and the wait script that reports on it.
    "login-wait.sh": (files) => {
      const code = files.get(`${DIR}/masttro-web.code`)?.toString();
      if (code) {
        files.delete(`${DIR}/masttro-web.code`);
        files.set(`${DIR}/masttro-web.json`, Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "remembered" }] })));
        files.set(`${DIR}/masttro-web.status`, Buffer.from(code === "123456" ? "ok" : "failed: wrong code"));
      }
      return { stdout: files.get(`${DIR}/masttro-web.status`)?.toString() ?? "starting" };
    },
  });
  return { sandboxes, seen };
}

describe("website logins", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("signs the job's browser in, asks the people on the job for the code, and keeps the session", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const clerk = await createAgent(ORG, { name: "Masttro data entry", role: "Data entry" });
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const login = await saveIntegration(ORG, {
      kind: "login",
      name: "Masttro (web)",
      slug: "masttro-web",
      config: {
        loginUrl: "https://app.masttro.example/login",
        domains: [],
        fields: [
          { name: "username", label: "Username", secret: false },
          { name: "password", label: "Password" },
          { name: "totp", label: "Authenticator setup key", optional: true },
        ],
      },
      access: "write",
      agentIds: [clerk.id],
    });
    await saveCredentials(ORG, login.id, { username: "ahmed@cedar.example", password: PASSWORD });
    // Only the chosen agent sees it.
    expect((await listIntegrations(ORG, { agentId: analyst.id })).map((i) => i.slug)).toEqual([]);

    const task = await createTask(ORG, { title: "Enter Q3 valuations in Masttro", people: [ahmed.id], agents: [clerk.id] });
    const { sandboxes, seen } = masttroSandboxes();
    setSandboxProvider(sandboxes.provider);
    const name = `mach-task-${task.id}`;

    // First run: Masttro asks for a code, so the job asks Ahmed and the run ends.
    const first = await runAgentOnTask(ORG, task.id, clerk.id, {
      research: false,
      model: scriptedModel([[["browser_login", { login: "masttro-web" }]], "should not get here"]),
    });
    expect(first).toEqual({ type: "asked" });
    expect(seen.creds).toMatchObject({ username: "ahmed@cedar.example", password: PASSWORD, config: { loginUrl: "https://app.masttro.example/login" } });
    expect([...sandboxes.machines.get(name)!.files.keys()].some((p) => p.startsWith("/tmp/mach-login-"))).toBe(false);
    expect(await getTask(ORG, task.id)).toMatchObject({ status: "waiting", pendingLogin: "masttro-web" });
    // The sandbox (and the waiting browser) is left running.
    expect(sandboxes.log).not.toContain(`stop ${name}`);

    // Ahmed replies with the code: it goes to the sign-in, not the thread, and the agent finishes signing in.
    const runs: Promise<void>[] = [];
    setScheduler((work) => runs.push(work()), {
      research: false,
      model: scriptedModel([
        [["browser_login", { login: "masttro-web" }]],
        [["finish", { summary: "Signed in to Masttro; ready to enter the valuations.", report: "Signed in." }]],
      ]),
    });
    await replyToTask(ORG, task.id, { name: "Ahmed", personId: ahmed.id }, "123 456");
    await Promise.all(runs);

    expect(await getTask(ORG, task.id)).toMatchObject({ status: "review", pendingLogin: null });
    const thread = await listMessages(task.id);
    expect(thread.map((m) => m.body)).toContain("Sent the masttro-web sign-in code.");
    expect(JSON.stringify(thread)).not.toMatch(/123 ?456|hunter2/);
    expect(sandboxes.log).toContain(`stop ${name}`);
    const saved = await readLogin(ORG, login.id);
    expect(saved.session).toContain("remembered");
    expect((await getIntegration(ORG, "masttro-web"))).toMatchObject({ status: "connected", hasSession: true });

    // A later job starts from the saved session, so Masttro doesn't ask again.
    const next = await createTask(ORG, { title: "Enter Q4 valuations", people: [ahmed.id], agents: [clerk.id] });
    const later = await runAgentOnTask(ORG, next.id, clerk.id, {
      research: false,
      model: scriptedModel([[["browser_login", { login: "masttro-web" }]], [["finish", { summary: "Signed in.", report: "Done." }]]]),
    });
    expect(later).toEqual({ type: "finished" });
    expect((await getTask(ORG, next.id))!.pendingLogin).toBeNull();
  });
});
