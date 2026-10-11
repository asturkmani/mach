import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";

import { sendLoginCode } from "@/lib/agents/browser-steps";
import { createChiefOfStaff, workspaceOf } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { closeSandbox } from "@/lib/agents/sandbox-steps";
import { listAgents } from "@/lib/agents/store";
import type { SandboxSession } from "@/lib/agents/toolkit";
import { readLogin, saveCredentials, saveIntegration } from "@/lib/integrations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { personalSandboxName, setSandboxProvider } from "@/lib/sandbox";
import { listTasks } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";
const PASSWORD = "hunter2-masttro-pw";
const DIR = "/vercel/job/.logins";
const SPEC = "https://dfo.masttro.example/api/swagger/v1/swagger.json";

/** Masttro's docs, faked: behind a sign-in that sends a code, with a Swagger page that loads its spec. */
function masttroDocs() {
  const seen: { creds?: Record<string, unknown>; browsedWith?: string } = {};
  const sandboxes = fakeSandboxes({
    "login.py": (files) => {
      const path = [...files.keys()].find((p) => p.startsWith("/tmp/mach-login-"))!;
      seen.creds = JSON.parse(files.get(path)!.toString());
      files.delete(path);
      files.set(`${DIR}/masttro-docs.status`, Buffer.from("needs_code"));
    },
    "login-wait.sh": (files) => {
      const code = files.get(`${DIR}/masttro-docs.code`)?.toString();
      if (code) {
        files.delete(`${DIR}/masttro-docs.code`);
        files.set(`${DIR}/masttro-docs.json`, Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "docs" }] })));
        files.set(`${DIR}/masttro-docs.status`, Buffer.from(code === "123456" ? "ok" : "failed: wrong code"));
      }
      return { stdout: files.get(`${DIR}/masttro-docs.status`)?.toString() ?? "starting" };
    },
    "browse.py": (files, [url, out, state]) => {
      seen.browsedWith = state;
      const signedIn = Boolean(state && files.get(state));
      files.set(
        out,
        Buffer.from(
          JSON.stringify({
            url,
            status: 200,
            contentType: "text/html",
            title: signedIn ? "Masttro API" : "Sign in",
            text: signedIn ? "Masttro API v1 · Authorize · GET /positions" : "Sign in to Masttro",
            links: [],
            requests: signedIn ? [{ url: SPEC, status: 200, type: "application/json" }] : [],
          }),
        ),
      );
    },
  });
  return { sandboxes, seen };
}

describe("the Chief of Staff's workspace", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
  });

  it("signs its own browser in to read API docs behind a sign-in, with the code going from the card to the browser", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    // A login only the Chief of Staff uses (no agents), with credentials entered in its card.
    const docs = await saveIntegration(ORG, {
      kind: "login",
      name: "Masttro API docs",
      slug: "masttro-docs",
      config: {
        loginUrl: "https://dfo.masttro.example/api/index.html",
        domains: ["dfo.masttro.example"],
        fields: [
          { name: "username", label: "Username", secret: false },
          { name: "password", label: "Password" },
        ],
      },
      access: "read",
    });
    await saveCredentials(ORG, docs.id, { username: "ahmed@cedar.example", password: PASSWORD });
    const { sandboxes, seen } = masttroDocs();
    setSandboxProvider(sandboxes.provider);
    // It works in Ahmed's own sandbox.
    const name = personalSandboxName(person.id);

    // A chat turn, as the chat route runs it, in one conversation: the sandbox is closed when the turn ends.
    const history: ModelMessage[] = [];
    const turn = async (steps: Step[], prompt: string) => {
      const sandbox: SandboxSession = {};
      const model = scriptedModel(steps);
      const agent = createChiefOfStaff({ organization, user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" }, person, profile: "" }, { model, research: false, sandbox });
      history.push({ role: "user", content: prompt });
      const result = await agent.generate({ messages: [...history] });
      history.push(...result.responseMessages);
      if (sandbox.used) await closeSandbox(workspaceOf({ organization, person }));
      return { result, model };
    };
    const offered = (model: ReturnType<typeof scriptedModel>, step: number) => (model.doGenerateCalls[step].tools ?? []).map((t) => t.name);

    // The docs need a sign-in; Masttro sends a code, so the chat shows a card for it and the browser waits.
    const first = await turn(
      [[["use_skill", { name: "connecting-integrations" }]], [["browser_login", { login: "masttro-docs" }]], "Masttro sent you a code: enter it in the card."],
      "Connect the Masttro API",
    );
    // Its sandbox and browser are for setting up integrations: off until that skill is loaded.
    expect(offered(first.model, 0)).not.toContain("browser_login");
    expect(offered(first.model, 0)).not.toContain("run_code");
    expect(offered(first.model, 1)).toEqual(expect.arrayContaining(["browser_login", "browse", "run_code"]));
    const login = first.result.steps[1].toolResults[0]!.output as { text: string; needsCode?: { slug: string } };
    expect(login.needsCode).toEqual({ slug: "masttro-docs", name: "Masttro API docs" });
    expect(seen.creds).toMatchObject({ username: "ahmed@cedar.example", password: PASSWORD });
    expect(sandboxes.log).toContain(`create ${name}`);
    expect(sandboxes.log).not.toContain(`stop ${name}`);
    expect(JSON.stringify(first.model.doGenerateCalls)).not.toContain(PASSWORD);

    // The code goes from the card straight to the browser; then the Chief of Staff finishes signing in and reads the docs.
    expect(await sendLoginCode(ORG, person.id, "masttro-docs", "123 456")).toEqual({});
    const second = await turn(
      [
        [["browser_login", { login: "masttro-docs" }]],
        [["browse", { url: "https://dfo.masttro.example/api/index.html" }]],
        "The docs list the spec at swagger.json; reading it next.",
      ],
      "I've entered the Masttro API docs sign-in code.",
    );
    // Still setting up, later in the same conversation: the browser is on.
    expect(offered(second.model, 0)).toContain("browser_login");
    const [signedIn, page] = second.result.steps.slice(0, 2).map((s) => s.toolResults[0]!.output as { text: string } | string);
    expect((signedIn as { text: string }).text).toMatch(/^Signed in to Masttro API docs/);
    expect(page).toContain("with the masttro-docs session");
    expect(page).toContain(`200 application/json ${SPEC}`);
    expect(seen.browsedWith).toBe(`${DIR}/masttro-docs.json`);
    expect((await readLogin(ORG, docs.id)).session).toContain("docs");
    expect(sandboxes.log).toContain(`stop ${name}`);
    expect(JSON.stringify(second.model.doGenerateCalls)).not.toMatch(/123 ?456|hunter2/);

    // No agent or task was made to do it.
    expect(await listAgents(ORG)).toEqual([]);
    expect(await listTasks(ORG)).toEqual([]);
  });

  it("refuses a code when no sign-in is waiting for one", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    setSandboxProvider(fakeSandboxes().provider);
    expect(await sendLoginCode(ORG, person.id, "masttro-docs", "123456")).toEqual({
      error: "That sign-in isn't waiting for a code any more. Ask the Chief of Staff to sign in again.",
    });
    expect(await sendLoginCode(ORG, person.id, "masttro-docs", "not a code!")).toEqual({ error: "That doesn't look like a sign-in code." });
  });
});
