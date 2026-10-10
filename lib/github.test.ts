import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { githubRequest } from "@/lib/agents/github-steps";
import { taskBrief } from "@/lib/agents/prompts";
import { workingForId } from "@/lib/agents/run-steps";
import { listAgents, WORKER_AGENT } from "@/lib/agents/store";
import { getDb } from "@/lib/db";
import { knownSecrets, sandboxPolicy } from "@/lib/integrations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember, savePerson } from "@/lib/people";
import { getTaskByNumber } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

import {
  commitIdentity,
  disconnectGitHub,
  getGitHubConnection,
  githubSigning,
  githubToken,
  saveGitHubConnection,
} from "./github";

const ORG = "org_cedar";
const HOUR = 3_600_000;
const sara = { id: "1001", login: "sara-h", name: "Sara Haddad" };

/** GitHub, faked: records requests and answers with whatever the handler returns. */
function fakeGitHub(handler: (url: URL, init: RequestInit) => { status?: number; json?: unknown }) {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      const out = handler(url, init);
      return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return requests;
}

const tokens = (accessToken: string, expiresIn = 8 * HOUR) => ({
  accessToken,
  refreshToken: `ghr_${accessToken}`,
  expiresAt: Date.now() + expiresIn,
  refreshExpiresAt: Date.now() + 180 * 24 * HOUR,
});

describe("each person's own GitHub", () => {
  let me: string;
  let colleague: string;

  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.mach1");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "app-secret");
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    me = (await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara Haddad" })).id;
    colleague = (await savePerson(ORG, { name: "Omar Khalil" })).id;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setScheduler(null);
  });

  it("keeps a person's tokens sealed and theirs alone", async () => {
    await saveGitHubConnection(ORG, me, tokens("ghu_sara_token"), sara);
    expect(await getGitHubConnection(ORG, me)).toMatchObject({ login: "sara-h", status: "connected" });
    expect(await githubToken(ORG, me)).toEqual({ token: "ghu_sara_token", account: sara });
    // Nobody else's work gets it.
    expect(await githubToken(ORG, colleague)).toBeNull();
    expect(await getGitHubConnection("org_other", me)).toBeNull();
    const [row] = await getDb().query<{ secrets: Uint8Array }>("select secrets from personal_connections");
    expect(Buffer.from(row.secrets).toString("utf8")).not.toContain("ghu_sara_token");
    // Anything a sandbox prints is scrubbed of it.
    expect(await knownSecrets(ORG)).toContain("ghu_sara_token");
    expect(commitIdentity(sara)).toEqual({ name: "Sara Haddad", email: "1001+sara-h@users.noreply.github.com" });
  });

  it("renews a token that's about to run out, and asks to reconnect when it can't", async () => {
    await saveGitHubConnection(ORG, me, tokens("ghu_old", 60_000), sara);
    const requests = fakeGitHub(() => ({ json: { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800, refresh_token_expires_in: 15897600 } }));
    expect((await githubToken(ORG, me))?.token).toBe("ghu_new");
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_ghu_old", client_id: "Iv1.mach1" });
    expect((await githubToken(ORG, me))?.token).toBe("ghu_new");
    expect(requests).toHaveLength(1);

    await saveGitHubConnection(ORG, me, tokens("ghu_revoked", 60_000), sara);
    fakeGitHub(() => ({ status: 400, json: { error: "bad_refresh_token" } }));
    expect(await githubToken(ORG, me)).toBeNull();
    expect(await getGitHubConnection(ORG, me)).toMatchObject({ status: "expired" });
  });

  it("disconnects, revoking the grant on GitHub", async () => {
    await saveGitHubConnection(ORG, me, tokens("ghu_sara_token"), sara);
    const requests = fakeGitHub(() => ({ status: 204 }));
    await disconnectGitHub(ORG, me);
    expect(await getGitHubConnection(ORG, me)).toBeNull();
    expect(requests[0].url.pathname).toBe("/applications/Iv1.mach1/grant");
    expect(requests[0].init.method).toBe("DELETE");
  });

  it("signs a task sandbox's GitHub traffic for its person, and nothing else changes", async () => {
    const signing = githubSigning("ghu_sara_token");
    expect(signing["github.com"].Authorization).toBe(`Basic ${Buffer.from("x-access-token:ghu_sara_token").toString("base64")}`);
    expect(signing["api.github.com"].Authorization).toBe("Bearer ghu_sara_token");
    const { policy } = await sandboxPolicy(ORG, signing);
    expect(policy).toEqual({
      allow: {
        "github.com": [{ transform: [{ headers: signing["github.com"] }] }],
        "api.github.com": [{ transform: [{ headers: signing["api.github.com"] }] }],
        "uploads.github.com": [{ transform: [{ headers: signing["uploads.github.com"] }] }],
        "*": [],
      },
    });
    expect((await sandboxPolicy(ORG)).policy).toBe("allow-all");
  });

  it("works for whoever wrote the message a run answers, else the last to comment, else who asked", () => {
    const task = { createdByPersonId: "creator" };
    const thread = [
      { id: "m1", personId: "creator", kind: "comment" as const },
      { id: "m2", personId: null, kind: "result" as const },
      { id: "m3", personId: "omar", kind: "comment" as const },
      { id: "m4", personId: "sara", kind: "comment" as const },
    ];
    expect(workingForId(task, thread, ["m3"])).toBe("omar");
    expect(workingForId(task, thread, ["m3", "m4"])).toBe("sara");
    expect(workingForId(task, thread, [])).toBe("sara");
    expect(workingForId(task, [], [])).toBe("creator");
    expect(workingForId({ createdByPersonId: null }, [], [])).toBeNull();
  });

  it("tells the agent whose GitHub it has, or how to get it connected", async () => {
    const base = { messages: [], files: [], agent: { id: "a", name: "Developer" } } as unknown as Parameters<typeof taskBrief>[0];
    const task = { members: [], number: 1, title: "Fix", status: "ready", priority: "medium", createdAt: new Date() } as unknown as Parameters<typeof taskBrief>[0]["task"];
    const connected = taskBrief({ ...base, task, workingFor: { name: "Sara Haddad", github: { login: "sara-h" }, connectUrl: "https://x/connect/github" } });
    expect(connected).toContain("This run is for Sara Haddad");
    expect(connected).toContain("connected as @sara-h");
    expect(connected).toContain("Never push to the default branch");
    const missing = taskBrief({ ...base, task, workingFor: { name: "Omar", github: null, connectUrl: "https://x/connect/github" } });
    expect(missing).toContain("Omar hasn't connected theirs");
    expect(missing).toContain("https://x/connect/github");
  });

  it("calls GitHub's API as the person the work is for", async () => {
    await saveGitHubConnection(ORG, me, tokens("ghu_sara_token"), sara);
    const requests = fakeGitHub(() => ({ json: [{ number: 7, title: "Fix typo" }] }));
    const asSara = { organizationId: ORG, taskId: null, agentId: null, agentName: "Chief of Staff", personId: me };
    const out = await githubRequest(asSara, { path: "/repos/cedar/site/pulls" });
    expect(out).toContain("→ 200 (as @sara-h)");
    expect(out).toContain("Fix typo");
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ghu_sara_token");
    expect(out).not.toContain("ghu_sara_token");
    // Omar hasn't connected his: he's sent to connect it, and Sara's is never used.
    const asOmar = await githubRequest({ ...asSara, personId: colleague }, { path: "/user" });
    expect(asOmar).toMatch(/Omar Khalil hasn't connected GitHub.*\/connect\/github/);
    expect(requests).toHaveLength(1);
  });

  it("starts a code change from WhatsApp as the person asking, with the Worker and the coding skill", async () => {
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const user = { id: "user_sara", email: "sara@cedar.example", name: "Sara Haddad" };
    const person = (await getPerson(ORG, me))!;
    setScheduler(() => {}); // the agent's run isn't part of this test
    const ask = (github: { login: string; status: "connected" } | null) => {
      const model = scriptedModel([
        [["start_coding", { title: "Fix the typo on the pricing page", request: "It says 'anual'.", repository: "cedar/site" }]],
        "On it.",
      ]);
      return createChiefOfStaff({ organization, user, person, profile: "", channel: "whatsapp", github }, { model, research: false })
        .generate({ prompt: "fix the typo on the pricing page" })
        .then(() => JSON.stringify(model.doGenerateCalls.at(-1)!.prompt));
    };

    // Not connected yet: no task, and the way to connect.
    expect(await ask(null)).toContain("needs to connect their GitHub first");
    expect(await getTaskByNumber(ORG, 1)).toBeNull();

    await saveGitHubConnection(ORG, me, tokens("ghu_sara_token"), sara);
    expect(await ask({ login: "sara-h", status: "connected" })).toContain("Started task #1: Worker is on it as @sara-h");
    const task = (await getTaskByNumber(ORG, 1))!;
    expect(task).toMatchObject({ title: "Fix the typo on the pricing page", createdByPersonId: me, replyByWhatsApp: true });
    expect(task.description).toContain("Repository: cedar/site");
    expect(task.members.map((m) => m.name)).toEqual(["Sara Haddad", "Worker"]);
    expect(task.skills).toEqual(["coding-in-github"]);
    expect((await listAgents(ORG)).find((a) => a.name === "Worker")?.builtin).toBe(WORKER_AGENT);
  });
});

