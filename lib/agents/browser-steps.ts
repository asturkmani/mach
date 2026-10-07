import type { RunContext } from "@/lib/agents/prompts";
import { JOB_DIR, sandboxNameFor, sandboxes, type JobSandbox } from "@/lib/sandbox";
import { allowedFor, getIntegration, readLogin, saveLoginSession, setLoginStatus, type LoginConfig } from "@/lib/integrations";
import { seal, unseal } from "@/lib/secrets";
import { addMessage, getTask, setPendingLogin, takeLoginCode, updateTask } from "@/lib/tasks";

// Website logins for browser work. browser_login signs the job's browser in
// to a site with the company's saved credentials: a helper in the sandbox
// fills the form, so the password never reaches the model. If the site asks
// for a sign-in code, the job asks the people on it; their reply is kept
// sealed and handed to the waiting helper on the agent's next run. The
// signed-in session is saved, so later runs (and other jobs) skip the login
// until the site signs it out.

export const LOGIN_DIR = `${JOB_DIR}/.logins`;
const HELPER = `${JOB_DIR}/.mach/login.py`;
const WAITER = `${JOB_DIR}/.mach/login-wait.sh`;

/** Runs in the sandbox: signs in with Playwright and reports through LOGIN_DIR/<slug>.status. */
const LOGIN_PY = String.raw`# Signs the job's browser in to a website. Written by Mach; credentials
# arrive in a file that is deleted as soon as it's read.
import base64, hashlib, hmac, json, os, re, struct, sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

slug, creds_path = sys.argv[1], sys.argv[2]
with open(creds_path) as f:
    creds = json.load(f)
os.remove(creds_path)
base = os.path.join("${LOGIN_DIR}", slug)
state_path = base + ".json"
cfg = creds["config"]
sel = cfg.get("selectors") or {}

def status(text):
    with open(base + ".status", "w") as f:
        f.write(text)

def totp(secret, step=30, digits=6):
    key = secret.replace(" ", "").upper()
    key = base64.b32decode(key + "=" * (-len(key) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time()) // step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)

USER = [sel["username"]] if sel.get("username") else [
    'input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[id*="user" i]',
    'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="login" i]', 'input[type="text"]']
PASSWORD = [sel.get("password") or 'input[type="password"]']
CODE = [sel["code"]] if sel.get("code") else [
    'input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[name*="mfa" i]',
    'input[name*="2fa" i]', 'input[name*="code" i]', 'input[id*="code" i]', 'input[name*="token" i]', 'input[inputmode="numeric"]']
ERRORS = ['[role="alert"]', '.alert-danger', '.error', '.invalid-feedback', '[class*="error" i]']

def visible(page, selectors):
    """The first visible element, trying the selectors in order of preference."""
    for selector in selectors:
        for element in page.locator(selector).all():
            try:
                if element.is_visible():
                    return element
            except Exception:
                pass
    return None

def settle(page):
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(1000)

def on_sign_in_page(page):
    return page.url.split("?")[0].rstrip("/") == cfg["loginUrl"].split("?")[0].rstrip("/")

def signed_in(page):
    failed = re.search(r"fail|error|denied|invalid", page.url, re.I)
    return not failed and not visible(page, PASSWORD) and not visible(page, CODE) and not on_sign_in_page(page)

def submit(page, field):
    button = visible(page, [sel["submit"]]) if sel.get("submit") else None
    if button:
        button.click()
    else:
        field.press("Enter")
    settle(page)

def page_error(page):
    element = visible(page, ERRORS)
    return element.inner_text().strip()[:200] if element else ""

def sign_in_code():
    """From the authenticator setup key if there is one, else from the people on the job."""
    if creds.get("totp"):
        return totp(creds["totp"])
    status("needs_code")
    deadline = time.time() + 600
    while not os.path.exists(base + ".code"):
        if time.time() > deadline:
            raise RuntimeError("no sign-in code arrived within 10 minutes")
        time.sleep(1)
    with open(base + ".code") as f:
        code = f.read().strip()
    os.remove(base + ".code")
    status("signing_in")
    return code

def enter_code(page, field):
    # Remember this browser, so later runs skip the code.
    try:
        box = page.get_by_label(re.compile("remember|trust this|don.t ask", re.I)).first
        if box.is_visible() and not box.is_checked():
            box.check()
    except Exception:
        pass
    field.fill(sign_in_code())
    submit(page, field)

page = None
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            storage_state=state_path if os.path.exists(state_path) else None, viewport={"width": 1366, "height": 900})
        page = context.new_page()
        status("signing_in")
        check = cfg.get("checkUrl") or creds.get("landingUrl")
        page.goto(check or cfg["loginUrl"], wait_until="domcontentloaded")
        settle(page)
        if not signed_in(page):
            if not visible(page, PASSWORD) and not visible(page, USER):
                page.goto(cfg["loginUrl"], wait_until="domcontentloaded")
                settle(page)
            user, password = visible(page, USER), visible(page, PASSWORD)
            if user and creds.get("username"):
                user.fill(creds["username"])
            if not password and user:
                # Two-step sign-in: the password comes on the next page.
                submit(page, user)
                password = visible(page, PASSWORD)
            if not password:
                raise RuntimeError("couldn't find the password field " + page_error(page))
            password.fill(creds["password"])
            code_field = visible(page, CODE)
            if code_field:
                # The code is asked for on the same page.
                enter_code(page, code_field)
            else:
                submit(page, password)
                code_field = visible(page, CODE)
                if code_field:
                    enter_code(page, code_field)
            if cfg.get("checkUrl"):
                page.goto(cfg["checkUrl"], wait_until="domcontentloaded")
                settle(page)
            if not signed_in(page):
                raise RuntimeError("still not signed in (" + page.url + ") " + page_error(page))
        context.storage_state(path=state_path)
        heading = visible(page, ["h1", "h2"])
        with open(base + ".landing", "w") as f:
            json.dump({"url": page.url, "title": page.title(), "heading": heading.inner_text().strip()[:200] if heading else ""}, f)
        status("ok")
        browser.close()
except Exception as error:
    try:
        if page:
            page.screenshot(path=base + ".png")
    except Exception:
        pass
    status("failed: " + (str(error).strip().splitlines() or ["unknown error"])[0][:300])
`;

/** Waits up to SECONDS for the helper to report something other than "working", then prints its status. */
const LOGIN_WAIT_SH = `#!/usr/bin/env bash
f="${LOGIN_DIR}/$1.status"
for _ in $(seq 1 "$2"); do
  if [ -f "$f" ] && ! grep -qxE 'starting|signing_in' "$f"; then cat "$f"; exit 0; fi
  sleep 1
done
cat "$f" 2>/dev/null || echo starting
`;

export type LoginResult = { text: string; needsCode?: { slug: string; name: string } };

async function open(context: RunContext): Promise<JobSandbox> {
  // The sandbox was started by the tool wrapper (startSandbox); this resumes it.
  return sandboxes().open(sandboxNameFor(context.taskId), async () => {});
}

async function waitForHelper(sandbox: JobSandbox, slug: string, seconds: number): Promise<string> {
  const result = await sandbox.run("bash", [WAITER, slug, String(seconds)], { timeoutMs: (seconds + 15) * 1000 });
  return result.stdout.trim();
}

type Landing = { url: string; title: string; heading: string };

async function readLanding(sandbox: JobSandbox, slug: string): Promise<Landing | null> {
  const raw = await sandbox.readFile(`${LOGIN_DIR}/${slug}.landing`).catch(() => null);
  try {
    return raw ? (JSON.parse(raw.toString("utf8")) as Landing) : null;
  } catch {
    return null;
  }
}

function signedInText(name: string, slug: string, landing: Landing | null, already = false): string {
  const statePath = `${LOGIN_DIR}/${slug}.json`;
  const where = landing
    ? ` Landed on ${landing.url}${landing.title ? ` ("${landing.title}"` : ""}${landing.heading ? `${landing.title ? ", " : " ("}heading "${landing.heading}"` : ""}${landing.title || landing.heading ? ")" : ""}.`
    : "";
  return `${already ? `Already signed in to ${name} in this job.` : `Signed in to ${name}.`}${where} The session is in ${statePath}: open pages with browser.new_context(storage_state="${statePath}"), start from the page you landed on rather than the sign-in page, and save the session back with context.storage_state(path="${statePath}") when you're done, so later runs stay signed in. Only call browser_login again (with again: true) if the site has signed you out.`;
}

async function finish(context: RunContext, sandbox: JobSandbox, slug: string, name: string, status: string): Promise<LoginResult> {
  const statePath = `${LOGIN_DIR}/${slug}.json`;
  if (status === "ok") {
    const state = await sandbox.readFile(statePath);
    const landing = await readLanding(sandbox, slug);
    if (state) await saveLoginSession(context.organizationId, slug, state.toString("utf8"), landing?.url);
    await setPendingLogin(context.taskId, null);
    return { text: signedInText(name, slug, landing) };
  }
  if (status === "needs_code") {
    await setPendingLogin(context.taskId, slug);
    return { text: "", needsCode: { slug, name } };
  }
  if (status.startsWith("failed")) {
    await setPendingLogin(context.taskId, null);
    await setLoginStatus(context.organizationId, slug, "failing", status.replace(/^failed:\s*/, "Sign-in failed: "));
    return {
      text: `Couldn't sign in to ${name}: ${status.replace(/^failed:\s*/, "")}. A screenshot of the page is at ${LOGIN_DIR}/${slug}.png (look at it with your own Playwright code or attach it). If the credentials are wrong, say so in your report: people update them on the Integrations page.`,
    };
  }
  return { text: `The sign-in to ${name} is still going. Call browser_login again in a moment.` };
}

/** Signs the job's browser in to a website login, or finishes a sign-in that was waiting for a code. */
export async function browserLogin(context: RunContext, input: { login: string; again?: boolean }): Promise<LoginResult> {
  "use step";
  const integration = await getIntegration(context.organizationId, input.login);
  if (!integration || integration.kind !== "login" || !allowedFor(integration, context.agentId)) {
    return { text: `There's no website login called ${input.login} you can use.` };
  }
  if (integration.status === "disabled") return { text: `${integration.name} is turned off.` };
  if (!integration.hasCredentials) return { text: `${integration.name}'s credentials haven't been entered yet. Say so in your report.` };
  const sandbox = await open(context);
  const { slug, name } = integration;
  const task = await getTask(context.organizationId, context.taskId);
  const current = (await sandbox.readFile(`${LOGIN_DIR}/${slug}.status`))?.toString("utf8").trim();

  if (task?.pendingLogin === slug && current === "needs_code") {
    const sealed = await takeLoginCode(context.taskId);
    if (!sealed) return { text: `${name} is still waiting for the sign-in code from the people on this task.`, needsCode: { slug, name } };
    const code = unseal<{ code: string }>(sealed).code;
    await sandbox.writeFiles([
      { path: `${LOGIN_DIR}/${slug}.status`, content: Buffer.from("signing_in") },
      { path: `${LOGIN_DIR}/${slug}.code`, content: Buffer.from(code) },
    ]);
    return finish(context, sandbox, slug, name, await waitForHelper(sandbox, slug, 90));
  }

  if (current === "ok" && !input.again && (await sandbox.readFile(`${LOGIN_DIR}/${slug}.json`))) {
    return { text: signedInText(name, slug, await readLanding(sandbox, slug), true) };
  }

  const login = await readLogin(context.organizationId, integration.id);
  const config = integration.config as LoginConfig;
  const creds = `/tmp/mach-login-${slug}-${crypto.randomUUID()}.json`;
  await sandbox.run("mkdir", ["-p", LOGIN_DIR, `${JOB_DIR}/.mach`]);
  await sandbox.writeFiles([
    { path: HELPER, content: Buffer.from(LOGIN_PY) },
    { path: WAITER, content: Buffer.from(LOGIN_WAIT_SH) },
    { path: `${LOGIN_DIR}/${slug}.status`, content: Buffer.from("starting") },
    // A saved session from an earlier run or job, so the site may not ask again.
    ...(login.session && (input.again || !(await sandbox.readFile(`${LOGIN_DIR}/${slug}.json`)))
      ? [{ path: `${LOGIN_DIR}/${slug}.json`, content: Buffer.from(login.session) }]
      : []),
    {
      path: creds,
      content: Buffer.from(
        JSON.stringify({
          config: { loginUrl: config.loginUrl, checkUrl: config.checkUrl, selectors: config.selectors },
          username: login.secrets.username ?? "",
          password: login.secrets.password ?? "",
          totp: login.secrets.totp ?? "",
          // Where an earlier sign-in landed: a page to check whether the saved session still works.
          landingUrl: login.landingUrl ?? "",
        }),
      ),
    },
  ]);
  await sandbox.run("chmod", ["600", creds]);
  await sandbox.start("python3", [HELPER, slug, creds], { cwd: JOB_DIR });
  return finish(context, sandbox, slug, name, await waitForHelper(sandbox, slug, 120));
}

/** The site wants a code: ask the people on the task, and end the run until they reply. */
export async function askForLoginCode(context: RunContext, login: { slug: string; name: string }): Promise<string> {
  "use step";
  await addMessage(context.taskId, {
    author: context.agentName,
    agentId: context.agentId,
    kind: "ask",
    body: `${login.name} sent a sign-in code (by text, email or your authenticator app). Reply here with just the code: it goes straight to the sign-in and isn't kept in this thread.`,
  });
  await updateTask(context.organizationId, context.taskId, {
    status: "waiting",
    summary: `${login.name} needs your sign-in code to continue. Reply with the code.`,
    options: [],
  });
  return "Asked the people on this task for the code. Your run ends here; their reply finishes the sign-in on your next run.";
}

/** A person's reply to a waiting sign-in, if it's a code: kept sealed for the agent's next run. */
export function loginCodeFrom(text: string): string | null {
  const code = text.trim().replace(/[\s-]/g, "");
  return /^[A-Za-z0-9]{4,10}$/.test(code) ? code : null;
}

export const sealLoginCode = (code: string) => seal({ code });

/** Saves sessions the agent's own scripts refreshed, so later runs and jobs reuse them. */
export async function saveLoginSessions(context: RunContext, sandbox: JobSandbox): Promise<void> {
  const listed = await sandbox.run("bash", ["-c", `ls ${LOGIN_DIR}/*.json 2>/dev/null | head -20`]);
  for (const path of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const slug = path.split("/").pop()!.replace(/\.json$/, "");
    const integration = await getIntegration(context.organizationId, slug);
    if (!integration || integration.kind !== "login" || !allowedFor(integration, context.agentId)) continue;
    const state = await sandbox.readFile(path);
    if (state) await saveLoginSession(context.organizationId, slug, state.toString("utf8"));
  }
}
