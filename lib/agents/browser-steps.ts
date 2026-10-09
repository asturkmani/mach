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
import { ensureBrowser, LIVE_BROWSER, TAB_PY } from "@/lib/agents/browser-live";

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
const INSPECTOR = `${JOB_DIR}/.mach/inspect.py`;

/**
 * Finding a sign-in form's parts, for the sign-in helper and inspect_site: a
 * username, a password, a sign-in code (by name, id, placeholder, label or
 * autocomplete; Masttro's is a password field called "Token") and the button
 * that submits it. Expects sel: CSS selectors given for the site, or {}.
 */
const FORM_PY = String.raw`USER = [sel["username"]] if sel.get("username") else [
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

def bot_check(page):
    """True when a bot check (Cloudflare and the like) stands in front of the page."""
    try:
        text = page.inner_text("body")[:2000]
    except Exception:
        return False
    return bool(re.search(r"performing security verification|verify(ing)? you are (a )?human|just a moment|checking your browser|are you a robot", text, re.I))

def field_label(element):
    try:
        return element.evaluate("""e => (Array.from(e.labels || []).map(l => l.innerText.trim()).find(Boolean)
            || e.placeholder || e.getAttribute('aria-label') || e.name || e.id || e.type || '').slice(0, 40)""")
    except Exception:
        return "?"

def describe_form(page):
    """What a person would see of the sign-in form: its fields (and which take a code) and buttons."""
    fields = []
    for element in page.locator(FIELDS).all()[:12]:
        try:
            if not element.is_visible():
                continue
            kind = "code" if is_code(element) else element.get_attribute("type") or "text"
            fields.append({"label": field_label(element), "kind": kind})
        except Exception:
            pass
    buttons = []
    for element in page.get_by_role("button").all()[:12]:
        try:
            name = element.inner_text().strip()
            if name and element.is_visible():
                buttons.append(name[:30])
        except Exception:
            pass
    return {"fields": fields, "buttons": buttons[:6]}

def form_words(form):
    fields = ", ".join(f"{f['label']} ({f['kind']})" for f in form["fields"]) or "no fields"
    return fields + ("; buttons: " + ", ".join(form["buttons"]) if form["buttons"] else "")
`;

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

${FORM_PY}
${TAB_PY}
SIGN_IN = re.compile(r"^\s*(sign ?in|log ?in|login)\b", re.I)

def sign_in_button(page):
    for role in ("button", "link"):
        for element in page.get_by_role(role, name=SIGN_IN).all():
            try:
                if element.is_visible():
                    return element
            except Exception:
                pass
    return None

def form_showing(page):
    """A sign-in form is on the page: a password or code field, or a username with a Sign in button.
    Judged by what's on the page, not its address: some apps (Masttro) sign in at the app's own address."""
    return bool(password_field(page) or code_field(page) or (visible(page, USER) and sign_in_button(page)))

def signed_in(page):
    failed = re.search(r"fail|error|denied|invalid", page.url, re.I)
    return not failed and not bot_check(page) and not form_showing(page)

def wait_signed_in(page, seconds=30):
    """After submitting: apps can take a while to swap the form for the app, so keep looking."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if signed_in(page):
            return True
        if page_error(page) and time.time() > deadline - seconds + 3:
            return False
        page.wait_for_timeout(1000)
    return signed_in(page)

def submit(page, field):
    # The form's own button where there is one: on some sites (React forms) Enter does nothing.
    button = submit_button(page)
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

def import_saved(context, path):
    """An earlier session (cookies and local storage) into a browser that doesn't have it."""
    with open(path) as f:
        saved = json.load(f)
    if saved.get("cookies"):
        context.add_cookies(saved["cookies"])
    for origin in saved.get("origins", []):
        items = origin.get("localStorage") or []
        if items:
            helper = context.new_page()
            try:
                helper.goto(origin["origin"], wait_until="domcontentloaded", timeout=20000)
                helper.evaluate("items => items.forEach(i => localStorage.setItem(i.name, i.value))", items)
            finally:
                helper.close()

def sign_in(page, saved=None):
    status("signing_in")
    check = cfg.get("checkUrl") or creds.get("landingUrl")
    page.goto(check or cfg["loginUrl"], wait_until="domcontentloaded")
    settle(page)
    if signed_in(page):
        return  # already signed in
    if saved:
        # Not signed in here yet: try the session saved by an earlier sign-in before the form.
        saved()
        page.goto(check or cfg["loginUrl"], wait_until="domcontentloaded")
        settle(page)
        if signed_in(page):
            return
    if not form_showing(page):
        page.goto(cfg["loginUrl"], wait_until="domcontentloaded")
        settle(page)
    if not form_showing(page):
        if bot_check(page):
            raise RuntimeError("the site's bot check blocks automated browsers at " + page.url)
        raise RuntimeError("couldn't find a sign-in form at " + page.url + "; check the sign-in page address")
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
    if not wait_signed_in(page):
        error = page_error(page)
        raise RuntimeError("the sign-in form is still showing after submitting (" + page.url + ")" + (": " + error if error else ", with no error on the page"))
    if cfg.get("checkUrl"):
        page.goto(cfg["checkUrl"], wait_until="domcontentloaded")
        settle(page)
        if not signed_in(page):
            raise RuntimeError("signed in, but " + cfg["checkUrl"] + " shows the sign-in form again")

# live: sign in inside the browser agent's own browser, in the tab it's using, so the session is its own
# (including what a site keeps per tab), instead of a separate browser whose cookies would be copied over.
live = creds.get("live")
page = None
try:
    with sync_playwright() as p:
        saved = None
        if live:
            browser = p.chromium.connect_over_cdp(live["cdp"], timeout=20000)
            context = browser.contexts[0]
            try:
                with open(live["tabs"]) as f:
                    tab_state = json.load(f)
            except Exception:
                tab_state = {}
            page = current_page(context, tab_state)
            if os.path.exists(state_path):
                saved = lambda: import_saved(context, state_path)
        else:
            browser = p.chromium.launch()
            context = browser.new_context(
                storage_state=state_path if os.path.exists(state_path) else None, viewport={"width": 1366, "height": 900})
            page = context.new_page()
        try:
            sign_in(page, saved)
        except Exception:
            # Keep what the page showed while the browser is still open, for whoever works out what went wrong.
            try:
                page.screenshot(path=base + ".png")
                with open(base + ".seen", "w") as f:
                    json.dump({"url": page.url, "title": page.title(), "botCheck": bot_check(page), "error": page_error(page), **describe_form(page)}, f)
            except Exception:
                pass
            raise
        context.storage_state(path=state_path)
        heading = visible(page, ["h1", "h2"])
        with open(base + ".landing", "w") as f:
            json.dump({"url": page.url, "title": page.title(), "heading": heading.inner_text().strip()[:200] if heading else ""}, f)
        status("ok")
        if not live:
            browser.close()  # a live browser stays open for the browser agent
except Exception as error:
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

/**
 * Runs in the sandbox: opens each link as a fresh visitor and writes down what
 * a person would find there: where it really ends up, a sign-in form and its
 * fields, a bot check, and a public API description (OpenAPI/Swagger) on that
 * site, summarised.
 */
const INSPECT_PY = String.raw`# Looks at websites for setting up integrations. Written by Mach1.
import json, re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

urls, out_path = json.loads(sys.argv[1]), sys.argv[2]
sel = {}
${FORM_PY}
SPEC_PATHS = ["/swagger/v1/swagger.json", "/api/swagger/v1/swagger.json", "/openapi.json", "/swagger.json", "/api/openapi.json",
    "/api/swagger.json", "/v3/api-docs", "/api-docs", "/api/v1/openapi.json", "/docs/openapi.json"]

def summarise_spec(url, spec):
    paths = spec.get("paths") or {}
    ops = [f"{m.upper()} {p}" for p, item in paths.items() for m in (item or {}) if m.lower() in ("get", "post", "put", "patch", "delete")]
    schemes = (spec.get("components") or {}).get("securitySchemes") or spec.get("securityDefinitions") or {}
    servers = [s.get("url") for s in spec.get("servers") or [] if s.get("url")] or ([spec.get("host", "") + spec.get("basePath", "")] if spec.get("host") else [])
    return {"url": url, "title": (spec.get("info") or {}).get("title", ""), "servers": servers,
            "auth": {k: {"type": v.get("type"), "scheme": v.get("scheme"), "in": v.get("in"), "name": v.get("name")} for k, v in schemes.items()},
            "operations": len(ops), "sample": ops[:25]}

def find_spec(context, origins, loaded):
    for url in loaded + [o + p for o in origins for p in SPEC_PATHS]:
        try:
            r = context.request.get(url, timeout=10000)
            if r.status != 200:
                continue
            spec = r.json()
            if isinstance(spec, dict) and ("openapi" in spec or "swagger" in spec):
                return summarise_spec(url, spec)
        except Exception:
            pass
    return None

results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for url in urls[:6]:
        context = browser.new_context(viewport={"width": 1366, "height": 900})
        page = context.new_page()
        visited, loaded = [], []
        page.on("framenavigated", lambda frame: frame == page.main_frame and visited.append(frame.url))
        def on_response(response):
            try:
                ctype = response.headers.get("content-type") or ""
                if ("json" in ctype or "yaml" in ctype) and re.search(r"swagger|openapi|api-docs", response.url, re.I):
                    loaded.append(response.url)
            except Exception:
                pass
        page.on("response", on_response)
        found = {"requested": url}
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
            settle(page)
            form = describe_form(page)
            found.update({
                "url": page.url, "status": response.status if response else None, "title": page.title(),
                "hosts": list(dict.fromkeys(urlparse(u).hostname for u in [url] + visited + [page.url] if urlparse(u).hostname)),
                "botCheck": bot_check(page),
                "signInForm": bool(password_field(page) or (code_field(page) and visible(page, USER))),
                "codeField": bool(code_field(page)),
                "form": form,
                "links": page.eval_on_selector_all("a[href]", """els => els.map(a => [a.innerText.trim().slice(0, 60), a.href])
                    .filter(([t, h]) => /api|developer|docs|integrat|sign ?in|log ?in|help/i.test(t + ' ' + h)).slice(0, 12)"""),
                "text": page.inner_text("body")[:600] if page.locator("body").count() else "",
            })
            origins = list(dict.fromkeys(f"{urlparse(u).scheme}://{urlparse(u).hostname}" for u in [url, page.url]))
            found["apiSpec"] = find_spec(context, origins, loaded)
        except Exception as error:
            found["error"] = (str(error).strip().splitlines() or ["failed"])[0][:200]
        results.append(found)
        context.close()
    browser.close()
with open(out_path, "w") as f:
    json.dump(results, f)
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
    const seen = await readSeen(sandbox, slug);
    return {
      text: `Couldn't sign in to ${name}: ${status.replace(/^failed:\s*/, "")}.${seen ? ` What the page showed: ${seen}.` : ""} A screenshot is at ${LOGIN_DIR}/${slug}.png. Work out why before telling anyone: is the sign-in page right (inspect_site), is a field missed (reconnect with selectors), is it a bot check? Only wrong or missing credentials need the people: then say so plainly and they update them in the card or on the Integrations page.`,
    };
  }
  return { text: `The sign-in to ${name} is still going. Call browser_login again in a moment.` };
}

type Seen = { url: string; title: string; botCheck: boolean; error: string; fields: { label: string; kind: string }[]; buttons: string[] };

/** What the sign-in page showed when it failed, in a line. */
async function readSeen(sandbox: JobSandbox, slug: string): Promise<string | null> {
  const raw = await sandbox.readFile(`${LOGIN_DIR}/${slug}.seen`).catch(() => null);
  if (!raw) return null;
  try {
    const seen = JSON.parse(raw.toString("utf8")) as Seen;
    const fields = seen.fields.map((f) => `${f.label || "?"} (${f.kind})`).join(", ") || "no fields";
    return [
      `${seen.url}${seen.title ? ` ("${seen.title}")` : ""}`,
      seen.botCheck ? "a bot check is in the way" : "",
      `fields: ${fields}`,
      seen.buttons.length ? `buttons: ${seen.buttons.join(", ")}` : "",
      seen.error ? `error on the page: "${seen.error}"` : "",
    ]
      .filter(Boolean)
      .join("; ");
  } catch {
    return null;
  }
}

/** Signs the agent's browser in to a website login, or finishes a sign-in that was waiting for a code. */
/**
 * live: sign in inside the browser agent's running browser (see browser-live.ts)
 * rather than a browser of the helper's own.
 */
export async function browserLogin(
  context: AgentContext,
  input: { login: string; again?: boolean },
  options: { live?: boolean } = {},
): Promise<LoginResult> {
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

  if (options.live) await ensureBrowser(sandbox);
  else if (current === "ok" && !input.again && (await sandbox.readFile(`${LOGIN_DIR}/${slug}.json`))) {
    return { text: signedInText(name, slug, await readLanding(sandbox, slug), true) };
  }

  const login = await readLogin(context.organizationId, integration.id);
  const config = integration.config as LoginConfig;
  const creds = `/tmp/mach-login-${slug}-${crypto.randomUUID()}.json`;
  await sandbox.run("mkdir", ["-p", LOGIN_DIR, `${JOB_DIR}/.mach`]);
  await sandbox.run("rm", ["-f", `${LOGIN_DIR}/${slug}.seen`]);
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
          live: options.live ? LIVE_BROWSER : undefined,
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

export type SiteInspection = {
  requested: string;
  url?: string;
  status?: number | null;
  title?: string;
  hosts?: string[];
  botCheck?: boolean;
  signInForm?: boolean;
  codeField?: boolean;
  form?: { fields: { label: string; kind: string }[]; buttons: string[] };
  links?: [string, string][];
  text?: string;
  apiSpec?: {
    url: string;
    title: string;
    servers: string[];
    auth: Record<string, { type?: string; scheme?: string; in?: string; name?: string }>;
    operations: number;
    sample: string[];
  } | null;
  error?: string;
};

/** Opens each link in the sandbox's browser as a fresh visitor and reports what's there (see INSPECT_PY). */
export async function inspectSites(context: AgentContext, urls: string[]): Promise<SiteInspection[]> {
  const sandbox = await open(context);
  const out = `/tmp/mach-inspect-${crypto.randomUUID()}.json`;
  await sandbox.run("mkdir", ["-p", `${JOB_DIR}/.mach`]);
  await sandbox.writeFiles([{ path: INSPECTOR, content: Buffer.from(INSPECT_PY) }]);
  const run = await sandbox.run("python3", [INSPECTOR, JSON.stringify(urls), out], { cwd: JOB_DIR, timeoutMs: 180_000 });
  const raw = await sandbox.readFile(out);
  if (!raw) {
    const why = (run.stderr || run.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300);
    return urls.map((requested) => ({ requested, error: why || "the browser failed" }));
  }
  return JSON.parse(raw.toString("utf8")) as SiteInspection[];
}

/** One inspection in plain lines for the model. */
export function inspectionText(site: SiteInspection): string {
  if (site.error && !site.url) return `${site.requested}: couldn't open it (${site.error}).`;
  const moved = site.url && site.url.split("?")[0] !== site.requested.split("?")[0] ? ` → ended up at ${site.url}` : "";
  const fields = site.form?.fields.map((f) => `${f.label || "?"} (${f.kind})`).join(", ");
  const spec = site.apiSpec;
  return [
    `${site.requested}${moved}${site.status ? ` [${site.status}]` : ""}${site.title ? ` "${site.title}"` : ""}`,
    site.hosts && site.hosts.length > 1 ? `  Went through: ${site.hosts.join(" → ")}` : "",
    site.botCheck ? "  A bot check (e.g. Cloudflare) blocks automated browsers here: agents can't read this page." : "",
    site.signInForm
      ? `  Sign-in form: ${fields}${site.codeField ? " (includes a sign-in code field: the code is asked for on the same form)" : ""}${site.form?.buttons.length ? `; buttons: ${site.form.buttons.join(", ")}` : ""}`
      : `  No sign-in form here${fields ? ` (fields: ${fields})` : ""}.`,
    spec
      ? `  Public API description at ${spec.url}: "${spec.title}", servers ${spec.servers.join(", ") || "(relative to that site)"}, auth ${
          Object.entries(spec.auth).map(([k, a]) => `${k}: ${[a.type, a.scheme, a.in && `in ${a.in}`, a.name].filter(Boolean).join(" ")}`).join("; ") || "not stated"
        }, ${spec.operations} operations, e.g. ${spec.sample.slice(0, 12).join(", ")}`
      : "  No public API description found on this site.",
    site.links?.length ? `  Relevant links: ${site.links.map(([t, h]) => `${t || "(no text)"} ${h}`).join(" | ")}` : "",
    site.text ? `  Page starts: ${site.text.replace(/\s+/g, " ").slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The inspect_site tool: what's really at each link. */
export async function inspectSite(context: AgentContext, input: { urls: string[] }): Promise<string> {
  "use step";
  const urls = input.urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 6);
  if (!urls.length) return "Give full links, starting with https://.";
  const sites = await inspectSites(context, urls);
  return redact(sites.map(inspectionText).join("\n\n"), await knownSecrets(context.organizationId));
}
