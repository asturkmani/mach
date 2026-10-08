import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask, taskBrief } from "@/lib/agents/runner";
import { createAgent } from "@/lib/agents/store";
import { readDriveFile } from "@/lib/drive";
import { listTaskFiles } from "@/lib/files";
import { getIntegration, saveCredentials, saveIntegration } from "@/lib/integrations";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { setSandboxProvider } from "@/lib/sandbox";
import { createTask, getTask, listMessages } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const KEY = "mst_live_7f3a9c2e1b";

describe("agents with data sources", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads a data source with call_api, and its sandbox code gets the key only at the network layer, only during the run", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const analyst = await createAgent(ORG, { name: "Analyst" });
    const source = await saveIntegration(ORG, {
      kind: "api",
      name: "Masttro",
      description: "Positions and transactions for every family entity.",
      config: { baseUrl: "https://api.masttro.example/v1", domains: [], fields: [{ name: "apiKey", label: "API key" }], headers: { Authorization: "Bearer {{apiKey}}" } },
      guide: "GET /positions?asOf=YYYY-MM-DD lists positions.",
    });
    await saveCredentials(ORG, source.id, { apiKey: KEY });
    const task = await createTask(ORG, { title: "Summarise today's positions", people: [ahmed.id], agents: [analyst.id] });

    // The brief lists the source; the key is nowhere in it.
    const brief = taskBrief({ task, messages: [], files: [], agent: analyst, integrations: [(await getIntegration(ORG, "masttro"))!] });
    expect(brief).toContain("- masttro: Masttro, read-only, https://api.masttro.example/v1");
    expect(brief).not.toContain(KEY);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        Response.json({ url: String(input), positions: [{ ticker: "MU", value: 1_200_000 }], note: `signed with ${KEY}` }),
      ),
    );
    // A careless script that prints what the API echoed, key included.
    const sandboxes = fakeSandboxes({ "summarise.py": () => ({ stdout: `MU 1.2m (server saw: Bearer ${KEY})` }) });
    setSandboxProvider(sandboxes.provider);

    const outcome = await runAgentOnTask(ORG, task.id, analyst.id, {
      research: false,
      model: scriptedModel([
        [["read_integration_guide", { integration: "masttro" }]],
        [["call_api", { integration: "masttro", path: "/positions", query: { asOf: "2026-10-06" } }]],
        [["call_api", { integration: "masttro", path: "/positions", save_as: "/vercel/drive/masttro/positions-2026-10-06.json" }]],
        [["run_code", { filename: "summarise.py", language: "python", code: "print('MU 1.2m')" }]],
        [["finish", { summary: "MU is the largest position at $1.2m.", report: "Done." }]],
      ]),
    });
    expect(outcome).toEqual({ type: "finished" });

    const machine = sandboxes.machines.get(`mach-task-${task.id}`)!;
    expect(machine.policies[0]).toMatchObject({
      allow: { "api.masttro.example": [{ transform: [{ headers: { Authorization: `Bearer ${KEY}` } }] }, expect.anything()], "*": [] },
    });
    expect(machine.policies.at(-1)).toBe("allow-all");
    // The saved response is on the drive, with the echoed key scrubbed.
    const saved = await readDriveFile(ORG, "masttro/positions-2026-10-06.json");
    expect(saved?.bytes.toString()).toContain('"ticker":"MU"');
    expect(saved?.bytes.toString()).not.toContain(KEY);
    // What the script printed reached the agent (and the script's notes) scrubbed.
    const script = (await listTaskFiles(ORG, task.id)).find((f) => f.name === "summarise.py")!;
    expect(script.versions[0].note).toContain("server saw: Bearer [secret]");
    // Nothing the agent wrote or saw on the task holds the key.
    const thread = JSON.stringify([await listMessages(task.id), await getTask(ORG, task.id)]);
    expect(thread).not.toContain(KEY);
  });
});
