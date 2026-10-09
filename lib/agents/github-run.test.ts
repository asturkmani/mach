import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { saveGitHubConnection } from "@/lib/github";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { addMessage, createTask } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const tokens = (accessToken: string) => ({ accessToken, refreshToken: null, expiresAt: null, refreshExpiresAt: null });

describe("task runs and people's GitHub", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("gives a run's sandbox the GitHub of the person it's for, only during the run, and nobody else's", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    await saveGitHubConnection(ORG, sara.id, tokens("ghu_sara_token"), { id: "1", login: "sara-h", name: "Sara" });
    await saveGitHubConnection(ORG, omar.id, tokens("ghu_omar_token"), { id: "2", login: "omar-k", name: "Omar" });
    const developer = await createAgent(ORG, { name: "Developer" });
    const task = await createTask(ORG, { title: "Fix the typo", createdBy: { personId: sara.id }, people: [sara.id, omar.id], agents: [developer.id] });
    const sandboxes = fakeSandboxes();
    setSandboxProvider(sandboxes.provider);
    const machine = () => sandboxes.machines.get(`mach-task-${task.id}`)!;
    const runOnce = () =>
      runAgentOnTask(ORG, task.id, developer.id, {
        research: false,
        model: scriptedModel([
          [["run_command", { command: "git push -u origin mach1/fix-typo" }]],
          [["finish", { summary: "PR opened.", report: "Done." }]],
        ]),
      });

    // Sara asked for it: her GitHub, and her name on commits.
    expect(await runOnce()).toEqual({ type: "finished" });
    const sign = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    expect(machine().policies[0]).toMatchObject({ allow: { "github.com": [{ transform: [{ headers: { Authorization: sign("ghu_sara_token") } }] }] } });
    expect(machine().policies.at(-1)).toBe("allow-all");
    expect(sandboxes.log.some((l) => l.includes("1+sara-h@users.noreply.github.com"))).toBe(true);

    // Omar writes next: that run is his, with his GitHub.
    await addMessage(task.id, { author: "Omar", personId: omar.id, kind: "comment", body: "Also fix the footer." });
    expect(await runOnce()).toEqual({ type: "finished" });
    const policies = machine().policies.filter((p) => p !== "allow-all");
    expect(policies[1]).toMatchObject({ allow: { "github.com": [{ transform: [{ headers: { Authorization: sign("ghu_omar_token") } }] }] } });
    expect(JSON.stringify(policies[1])).not.toContain(Buffer.from("x-access-token:ghu_sara_token").toString("base64"));
    expect(machine().policies.at(-1)).toBe("allow-all");
  });
});
