import type { AgentContext, RunContext } from "@/lib/agents/prompts";
import { JOB_DIR, openCompanySandbox, sandboxes, sandboxNameOf, workspaceSandboxName, type JobSandbox } from "@/lib/sandbox";
import {
  allowedFor,
  getIntegration,
  knownSecrets,
  listIntegrations,
  matchesDomain,
  readLogin,
  saveLoginSession,
  setLoginStatus,
  type LoginConfig,
} from "@/lib/integrations";
import { redact, seal, unseal } from "@/lib/secrets";
import { addMessage, getTask, setPendingLogin, takeLoginCode, updateTask } from "@/lib/tasks";

// The browser every agent has in its sandbox. browser_login signs it in to a
// site with the company's saved credentials: a helper in the sandbox fills the
// form, so the password never reaches the model. If the site asks for a
// sign-in code, an agent on a task asks the people on it (their reply is kept
// sealed and handed to the waiting helper on the agent's next run); the Chief
// of Staff shows a code card in the chat that hands it over directly. The
// signed-in session is saved, so later runs (and other jobs) skip the login
// until the site signs it out. browse reads a page in that browser.

export const LOGIN_DIR = `${JOB_DIR}/.logins`;
const HELPER = `${JOB_DIR}/.mach/login.py`;
const WAITER = `${JOB_DIR}/.mach/login-wait.sh`;
const BROWSER = `${JOB_DIR}/.mach/browse.py`;

/** Runs in the sandbox: signs in with Playwright and reports through LOGIN_DIR/<slug>.status. */
const LOGIN_PY = String.raw`# Signs the job's browser in to a website. Written by Mach1; credentials
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
    'input[placeholder*="user" i]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]',
    'input[name*="login" i]', 'input[type="text"]']
# A sign-in code field, by any of the ways sites name one: its name, id, placeholder, label or
# autocomplete. Some sites (Masttro) make it a password field called just "Token".
CODE_WORDS = re.compile(r"one.?time|otp|mfa|2fa|two.?factor|token|code|passcode|verification|authenticat|security.?key", re.I)
FIELDS = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])'
SUBMIT = re.compile(r"^\s*(sign ?in|log ?in|login|continue|next|verify|submit|confirm)\b", re.I)
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

def is_code(element):
    """True for a field that takes a sign-in code rather than a username or password."""
    try:
        described = element.evaluate("""e => [e.name, e.id, e.placeholder, e.getAttribute('aria-label'),
            e.autocomplete, ...Array.from(e.labels || []).map(l => l.innerText)].filter(Boolean).join(' ')""")
    except Exception:
        return False
    return bool(CODE_WORDS.search(described)) and not re.search(r"user|e.?mail|password|country|promo|coupon|zip|post", described, re.I)

def code_field(page):
    if sel.get("code"):
        return visible(page, [sel["code"]])
    for element in page.locator(FIELDS).all():
        try:
            if element.is_visible() and is_code(element):
                return element
        except Exception:
            pass
    return None

def password_field(page):
    """The visible password field that isn't a code field dressed as one."""
    for element in page.locator(sel.get("password") or 'input[type="password"]').all():
        try:
            if element.is_visible() and (sel.get("password") or not is_code(element)):
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
    return not failed and not password_field(page) and not code_field(page) and not on_sign_in_page(page)

def submit_button(page):
    if sel.get("submit"):
        return visible(page, [sel["submit"]])
    for role in ("button", "link"):
        for element in page.get_by_role(role, name=SUBMIT).all():
            try:
                if element.is_visible() and element.is_enabled():
                    return element
            except Exception:
                pass
    return visible(page, ['button[type="submit"]', 'input[type="submit"]'])

def submit(page, field):
    # The form's own button where there is one: on some sites (React forms) Enter does nothing.
    button = submit_button(page)
    if button:
        button.click()
    else:
        field.press("Enter")
    settle(page)

def bot_check(page):
    """True when a bot check (Cloudflare and the like) stands in front of the page."""
    try:
        text = page.inner_text("body")[:2000]
    except Exception:
        return False
    return bool(re.search(r"performing security verification|verify(ing)? you are (a )?human|just a moment|checking your browser|are you a robot", text, re.I))

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
            if not password_field(page) and not visible(page, USER):
                page.goto(cfg["loginUrl"], wait_until="domcontentloaded")
                settle(page)
            if not password_field(page) and not visible(page, USER):
                if bot_check(page):
                    raise RuntimeError("the site's bot check blocks automated browsers at " + page.url)
                raise RuntimeError("couldn't find a sign-in form at " + page.url + "; check the sign-in page address on the Integrations page")
            user, password = visible(page, USER), password_field(page)
            if user and creds.get("username"):
                user.fill(creds["username"])
            if not password and user:
                # Two-step sign-in: the password comes on the next page.
                submit(page, user)
                password = password_field(page)
            if not password:
                raise RuntimeError("couldn't find the password field " + page_error(page))
            password.fill(creds["password"])
            code = code_field(page)
            if code:
                # The code is asked for on the same page, alongside the password.
                enter_code(page, code)
            else:
                submit(page, password)
                code = code_field(page)
                if code:
                    enter_code(page, code)
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

/** Runs in the sandbox: opens a page (signed in with a saved session, if given) and writes what it found as JSON. */
const BROWSE_PY = String.raw`# Opens a page in the agent's browser. Written by Mach1.
import json, os, sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

url, out_path, state_path, save_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
result = {}
seen = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(
        storage_state=state_path if state_path and os.path.exists(state_path) else None, viewport={"width": 1366, "height": 900})
    page = context.new_page()

    def on_response(response):
        try:
            kind = response.request.resource_type
            ctype = (response.headers.get("content-type") or "").split(";")[0]
            if kind in ("xhr", "fetch") or "json" in ctype or "yaml" in ctype:
                seen.append({"url": response.url, "status": response.status, "type": ctype})
        except Exception:
            pass

    page.on("response", on_response)
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
    except PlaywrightTimeout:
        response = None
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PlaywrightTimeout:
        pass
    ctype = ((response.headers.get("content-type") if response else "") or "").split(";")[0]
    result.update({"url": page.url, "status": response.status if response else None, "contentType": ctype})
    if response and ctype and "html" not in ctype:
        body = response.body()
        result["text"] = body.decode("utf-8", "replace")
        result["bytes"] = len(body)
        if save_path:
            with open(save_path, "wb") as f:
                f.write(body)
    else:
        result["title"] = page.title()
        result["text"] = page.inner_text("body") if page.locator("body").count() else ""
        result["links"] = page.eval_on_selector_all(
            "a[href]", "els => els.slice(0, 60).map(a => [a.innerText.trim().slice(0, 80), a.href])")
        if save_path:
            with open(save_path, "w") as f:
                f.write(page.content())
        result["bytes"] = len(result["text"])
    result["requests"] = [r for r in seen if r["url"] != page.url][:40]
    if state_path:
        context.storage_state(path=state_path)
    browser.close()
with open(out_path, "w") as f:
    json.dump(result, f)
`;

export type LoginResult = { text: string; needsCode?: { slug: string; name: string } };

async function open(context: AgentContext): Promise<JobSandbox> {
  // The sandbox was started by the tool wrapper (startSandbox); this resumes it.
  return openCompanySandbox(context.organizationId, sandboxNameOf(context), async () => {});
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

async function finish(context: AgentContext, sandbox: JobSandbox, slug: string, name: string, status: string): Promise<LoginResult> {
  const statePath = `${LOGIN_DIR}/${slug}.json`;
  if (status === "ok") {
    const state = await sandbox.readFile(statePath);
    const landing = await readLanding(sandbox, slug);
    if (state) await saveLoginSession(context.organizationId, slug, state.toString("utf8"), landing?.url);
    if (context.taskId) await setPendingLogin(context.taskId, null);
    return { text: signedInText(name, slug, landing) };
  }
  if (status === "needs_code") {
    if (context.taskId) await setPendingLogin(context.taskId, slug);
    return { text: `${name} sent a sign-in code.`, needsCode: { slug, name } };
  }
  if (status.startsWith("failed")) {
    if (context.taskId) await setPendingLogin(context.taskId, null);
    await setLoginStatus(context.organizationId, slug, "failing", status.replace(/^failed:\s*/, "Sign-in failed: "));
    return {
      text: `Couldn't sign in to ${name}: ${status.replace(/^failed:\s*/, "")}. A screenshot of the page is at ${LOGIN_DIR}/${slug}.png (look at it with your own Playwright code or attach it). If the credentials are wrong, say so in your report: people update them on the Integrations page.`,
    };
  }
  return { text: `The sign-in to ${name} is still going. Call browser_login again in a moment.` };
}

/** Signs the agent's browser in to a website login, or finishes a sign-in that was waiting for a code. */
export async function browserLogin(context: AgentContext, input: { login: string; again?: boolean }): Promise<LoginResult> {
  "use step";
  const integration = await getIntegration(context.organizationId, input.login);
  if (!integration || integration.kind !== "login" || !allowedFor(integration, context.agentId)) {
    return { text: `There's no website login called ${input.login} you can use.` };
  }
  if (integration.status === "disabled") return { text: `${integration.name} is turned off.` };
  if (!integration.hasCredentials) return { text: `${integration.name}'s credentials haven't been entered yet. Say so in your report.` };
  const sandbox = await open(context);
  const { slug, name } = integration;
  const task = context.taskId ? await getTask(context.organizationId, context.taskId) : null;
  const current = (await sandbox.readFile(`${LOGIN_DIR}/${slug}.status`))?.toString("utf8").trim();

  if (!context.taskId && !input.again) {
    // In the workspace, the code goes from the chat's code card straight to the waiting helper.
    if (current === "needs_code") return { text: `${name} is still waiting for the sign-in code.`, needsCode: { slug, name } };
    if (current === "signing_in") return finish(context, sandbox, slug, name, await waitForHelper(sandbox, slug, 90));
  }

  if (context.taskId && task?.pendingLogin === slug && current === "needs_code") {
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
export async function saveLoginSessions(context: AgentContext, sandbox: JobSandbox): Promise<void> {
  const listed = await sandbox.run("bash", ["-c", `ls ${LOGIN_DIR}/*.json 2>/dev/null | head -20`]);
  for (const path of listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const slug = path.split("/").pop()!.replace(/\.json$/, "");
    const integration = await getIntegration(context.organizationId, slug);
    if (!integration || integration.kind !== "login" || !allowedFor(integration, context.agentId)) continue;
    const state = await sandbox.readFile(path);
    if (state) await saveLoginSession(context.organizationId, slug, state.toString("utf8"));
  }
}

/** True while a sign-in in this sandbox waits for someone's code (its browser must keep running). */
export async function waitingForCode(sandbox: JobSandbox): Promise<boolean> {
  const result = await sandbox.run("bash", ["-c", `grep -lxE 'needs_code|signing_in' ${LOGIN_DIR}/*.status 2>/dev/null || true`]);
  return result.stdout.trim().length > 0;
}

/**
 * Hands a sign-in code from the chat's code card to the Chief of Staff's
 * waiting browser, without it passing through the model or the chat.
 */
export async function sendWorkspaceLoginCode(organizationId: string, slug: string, code: string): Promise<{ error?: string }> {
  const clean = loginCodeFrom(code);
  if (!clean) return { error: "That doesn't look like a sign-in code." };
  const sandbox = await sandboxes().find(workspaceSandboxName(organizationId));
  const current = sandbox ? (await sandbox.readFile(`${LOGIN_DIR}/${slug}.status`))?.toString("utf8").trim() : null;
  if (!sandbox || current !== "needs_code") return { error: "That sign-in isn't waiting for a code any more. Ask the Chief of Staff to sign in again." };
  await sandbox.writeFiles([
    { path: `${LOGIN_DIR}/${slug}.status`, content: Buffer.from("signing_in") },
    { path: `${LOGIN_DIR}/${slug}.code`, content: Buffer.from(clean) },
  ]);
  return {};
}

const BROWSE_TEXT_LIMIT = 15_000;

/**
 * Opens a page in the agent's browser, signed in with the session of the
 * company login for that site (if there is one), and returns what's on it:
 * its text and links, or the body of a JSON or other non-HTML response, plus
 * the data the page loaded (where a Swagger page's API spec shows up).
 */
export async function browsePage(context: AgentContext, input: { url: string; save_as?: string }): Promise<string> {
  "use step";
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return "Give a full URL, starting with https://.";
  }
  const sandbox = await open(context);
  const logins = (await listIntegrations(context.organizationId, { agentId: context.agentId })).filter(
    (i) => i.kind === "login" && i.status !== "disabled",
  );
  const login = logins.find((i) => {
    const config = i.config as LoginConfig;
    const hosts = [...config.domains];
    try {
      hosts.push(new URL(config.loginUrl).hostname);
    } catch {}
    return matchesDomain(url.hostname, hosts);
  });
  let statePath = "";
  if (login) {
    statePath = `${LOGIN_DIR}/${login.slug}.json`;
    if (!(await sandbox.readFile(statePath))) {
      const saved = await readLogin(context.organizationId, login.id);
      if (saved.session) await sandbox.writeFiles([{ path: statePath, content: Buffer.from(saved.session) }]);
      else statePath = "";
    }
  }
  const savePath = input.save_as ? `${JOB_DIR}/${input.save_as.replace(/^\/+|\.\.\/?/g, "")}` : "";
  const out = `/tmp/mach-browse-${crypto.randomUUID()}.json`;
  await sandbox.run("mkdir", ["-p", `${JOB_DIR}/.mach`, ...(savePath ? [savePath.slice(0, savePath.lastIndexOf("/"))] : [])]);
  await sandbox.writeFiles([{ path: BROWSER, content: Buffer.from(BROWSE_PY) }]);
  const run = await sandbox.run("python3", [BROWSER, url.href, out, statePath, savePath], { cwd: JOB_DIR, timeoutMs: 90_000 });
  const raw = await sandbox.readFile(out);
  if (!raw) return `Couldn't open ${url.href}: ${(run.stderr || run.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400) || "the browser failed"}`;
  const page = JSON.parse(raw.toString("utf8")) as {
    url: string;
    status: number | null;
    contentType: string;
    title?: string;
    text: string;
    bytes?: number;
    links?: [string, string][];
    requests: { url: string; status: number; type: string }[];
  };
  const text = page.text.length > BROWSE_TEXT_LIMIT ? `${page.text.slice(0, BROWSE_TEXT_LIMIT)}\n[…${page.text.length - BROWSE_TEXT_LIMIT} more characters${savePath ? "" : "; use save_as to keep all of it"}]` : page.text;
  const lines = [
    `${page.url} (${page.status ?? "no response"}${page.contentType ? `, ${page.contentType}` : ""}) · ${login ? (statePath ? `with the ${login.slug} session` : `not signed in to ${login.slug} yet: call browser_login first if the page asks you to sign in`) : "no company login for this site"}`,
    page.title ? `Title: ${page.title}` : "",
    "",
    text.trim() || "(no text)",
    page.links?.length ? `\nLinks:\n${page.links.filter(([, href]) => href.startsWith("http")).slice(0, 40).map(([label, href]) => `- ${label || "(no text)"}: ${href}`).join("\n")}` : "",
    page.requests.length ? `\nData the page loaded:\n${page.requests.map((r) => `- ${r.status} ${r.type || "?"} ${r.url}`).join("\n")}` : "",
    /performing security verification|verify(ing)? you are (a )?human|checking your browser/i.test(page.text.slice(0, 2000))
      ? "\nThis page is a bot check (e.g. Cloudflare) that blocks agents' browsers, and trying again won't get past it. Ask the people to save the page as a PDF and attach it, or use the site's API if it has one."
      : "",
    savePath ? `\nSaved the full ${page.contentType || "page"} (${page.bytes ?? 0} bytes) to ${savePath}.` : "",
  ];
  return redact(lines.filter((l, i) => l || i === 2).join("\n"), await knownSecrets(context.organizationId));
}
