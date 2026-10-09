import type { AgentContext } from "@/lib/agents/prompts";
import { JOB_DIR, openCompanySandbox, sandboxNameOf, type JobSandbox } from "@/lib/sandbox";

// The browser agent's browser: one Chromium that stays open in the caller's
// sandbox (the job's, or the company workspace's for the Chief of Staff), so
// tabs, sign-ins and the page it's on carry over between its steps and
// between calls. Its profile lives in the job folder, so cookies survive the
// sandbox stopping. Each step is a short Python script that attaches to it
// over the DevTools port, does a batch of actions and takes a screenshot.

const BROWSER_DIR = `${JOB_DIR}/.browser`;
const PROFILE = `${BROWSER_DIR}/profile`;
const READY = `${BROWSER_DIR}/ready`;
const SERVER = `${JOB_DIR}/.mach/browser-server.py`;
const STEP = `${JOB_DIR}/.mach/browser-step.py`;
const PORT = 9333;
export const VIEWPORT = { width: 1280, height: 800 };

/** Where the sign-in helper finds this browser and the tab it's on, to sign in inside it. */
export const LIVE_BROWSER = { cdp: `http://127.0.0.1:${PORT}`, tabs: `${BROWSER_DIR}/state.json` };

/**
 * Finding "the tab the agent is on" again from a new connection: by the tab's
 * DevTools target id, saved in the state file (the order of tabs isn't stable
 * between connections). Shared with the sign-in helper, which signs in there.
 */
export const TAB_PY = String.raw`def target_id(context, page):
    try:
        session = context.new_cdp_session(page)
        info = session.send("Target.getTargetInfo")
        session.detach()
        return info["targetInfo"]["targetId"]
    except Exception:
        return None

def current_page(context, state):
    pages = [pg for pg in context.pages if not pg.url.startswith("devtools://")] or [context.new_page()]
    wanted = state.get("target")
    if wanted:
        for candidate in pages:
            if target_id(context, candidate) == wanted:
                return candidate
    return pages[-1]
`;

/** Keeps the browser open until the ready file is removed. */
const SERVER_PY = String.raw`# The browser agent's browser. Written by Mach1.
import os, sys, time
from playwright.sync_api import sync_playwright

profile, port, ready = sys.argv[1], sys.argv[2], sys.argv[3]
with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        profile, headless=True, viewport={"width": ${VIEWPORT.width}, "height": ${VIEWPORT.height}}, accept_downloads=True,
        args=["--remote-debugging-port=" + port, "--remote-debugging-address=127.0.0.1"])
    if not context.pages:
        context.new_page()
    with open(ready, "w") as f:
        f.write(str(os.getpid()))
    while os.path.exists(ready):
        time.sleep(2)
    context.close()
`;

/** One step: attach, run the command, screenshot, report. */
const STEP_PY = String.raw`# One browser agent step. Written by Mach1.
import base64, contextlib, io, json, os, re, signal, sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

command = json.load(open(sys.argv[1]))
out_path, shot_path, state_path = sys.argv[2], sys.argv[3], "${BROWSER_DIR}/state.json"
result = {"actions": []}

def load_state():
    try:
        return json.load(open(state_path))
    except Exception:
        return {}

${TAB_PY}
def settle(page, ms=6000):
    try:
        page.wait_for_load_state("domcontentloaded", timeout=ms)
        page.wait_for_load_state("networkidle", timeout=ms)
    except PlaywrightTimeout:
        pass

def locate(page, t):
    if t.get("role"):
        loc = page.get_by_role(t["role"], name=t.get("name"), exact=bool(t.get("exact")))
    elif t.get("label"):
        loc = page.get_by_label(t["label"], exact=bool(t.get("exact")))
    elif t.get("placeholder"):
        loc = page.get_by_placeholder(t["placeholder"], exact=bool(t.get("exact")))
    elif t.get("text"):
        loc = page.get_by_text(t["text"], exact=bool(t.get("exact")))
    elif t.get("selector"):
        loc = page.locator(t["selector"])
    else:
        raise ValueError("say which element: role and name, label, placeholder, text or selector")
    return loc.nth(int(t.get("nth", 0)))

ELEMENTS_JS = """(query) => {
  const seen = [];
  const interactive = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[contenteditable=true]';
  const nodes = query ? document.querySelectorAll('body *') : document.querySelectorAll(interactive);
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder ||
      (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? el.name : '') || el.innerText || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (query) {
      if (!label.toLowerCase().includes(query.toLowerCase())) continue;
      if ([...el.children].some(c => (c.innerText || '').toLowerCase().includes(query.toLowerCase()))) continue;
    }
    const kind = el.getAttribute('role') || el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? ':' + el.type : '');
    seen.push({ kind, label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      value: el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : 'unchecked') : undefined) });
    if (seen.length >= 60) break;
  }
  return seen;
}"""

def act(page, context, a):
    kind = a.get("do")
    target = a.get("target")
    if kind == "goto":
        page.goto(a["url"], wait_until="domcontentloaded", timeout=30000)
        settle(page)
    elif kind in ("click", "double_click", "right_click", "hover"):
        clicks = 2 if kind == "double_click" else 1
        button = "right" if kind == "right_click" else "left"
        def do():
            if target:
                loc = locate(page, target)
                if kind == "hover":
                    loc.hover(timeout=8000)
                else:
                    loc.click(timeout=8000, click_count=clicks, button=button)
            elif kind == "hover":
                page.mouse.move(a["x"], a["y"])
            else:
                page.mouse.click(a["x"], a["y"], click_count=clicks, button=button)
        if a.get("download"):
            with page.expect_download(timeout=60000) as d:
                do()
            download = d.value
            os.makedirs("${JOB_DIR}/outputs/downloads", exist_ok=True)
            path = "${JOB_DIR}/outputs/downloads/" + (a.get("save_as") or download.suggested_filename)
            download.save_as(path)
            return {"downloaded": path}
        do()
        settle(page, 4000)
    elif kind == "type":
        if target:
            loc = locate(page, target)
            if a.get("clear", True):
                loc.fill(a["text"], timeout=8000)
            else:
                loc.press_sequentially(a["text"], delay=20, timeout=8000)
        else:
            page.keyboard.type(a["text"], delay=20)
        if a.get("submit"):
            page.keyboard.press("Enter")
            settle(page, 4000)
    elif kind == "press":
        page.keyboard.press(a["keys"])
        settle(page, 3000)
    elif kind == "scroll":
        page.mouse.move(a.get("x", ${VIEWPORT.width / 2}), a.get("y", ${VIEWPORT.height / 2}))
        page.mouse.wheel(a.get("dx", 0), a.get("dy", 600))
        page.wait_for_timeout(400)
    elif kind == "select":
        loc = locate(page, target)
        try:
            loc.select_option(label=a["option"], timeout=8000)
        except Exception:
            loc.select_option(value=a["option"], timeout=8000)
    elif kind in ("check", "uncheck"):
        loc = locate(page, target)
        (loc.check if kind == "check" else loc.uncheck)(timeout=8000)
    elif kind == "upload":
        locate(page, target).set_input_files(a["path"], timeout=8000)
    elif kind == "wait":
        page.wait_for_timeout(min(int(a.get("ms", 1000)), 5000))
    elif kind == "wait_for":
        timeout = min(int(a.get("timeout_ms", 10000)), 20000)
        if a.get("text"):
            page.get_by_text(a["text"]).first.wait_for(state="hidden" if a.get("gone") else "visible", timeout=timeout)
        elif a.get("url"):
            page.wait_for_url(re.compile(re.escape(a["url"])), timeout=timeout)
        else:
            settle(page, timeout)
    elif kind == "back":
        page.go_back(wait_until="domcontentloaded")
        settle(page, 4000)
    elif kind == "forward":
        page.go_forward(wait_until="domcontentloaded")
    elif kind == "reload":
        page.reload(wait_until="domcontentloaded")
        settle(page)
    elif kind == "tab":
        pages = context.pages
        if a.get("new"):
            page = context.new_page()
            if a.get("url"):
                page.goto(a["url"], wait_until="domcontentloaded", timeout=30000)
        else:
            page = pages[int(a.get("index", len(pages) - 1))]
        page.bring_to_front()
        return {"page": page}
    elif kind == "close_tab":
        page.close()
        pages = context.pages or [context.new_page()]
        return {"page": pages[-1]}
    else:
        raise ValueError("unknown action " + str(kind))
    return {}

def run_script(page, context, code):
    out = io.StringIO()
    def timeout(*_):
        raise TimeoutError("the script ran for more than 90 seconds")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(90)
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<script>", "exec"), {"page": page, "context": context, "json": json, "re": re, "time": time})
    finally:
        signal.alarm(0)
    return out.getvalue()[-12000:]

def tabs(context, page):
    return [{"index": i, "url": p.url, "current": p == page} for i, p in enumerate(context.pages)]

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:${PORT}", timeout=20000)
    context = browser.contexts[0]
    page = current_page(context, load_state())
    dialogs = []
    def on_dialog(dialog):
        dialogs.append({"type": dialog.type, "message": dialog.message[:300]})
        (dialog.accept if command.get("accept_dialogs") else dialog.dismiss)()
    context.on("page", lambda new: new.on("dialog", on_dialog))
    for existing in context.pages:
        existing.on("dialog", on_dialog)
    try:
        kind = command["type"]
        if kind == "act":
            opened = len(context.pages)
            for a in command.get("actions", [])[:20]:
                entry = {"do": a.get("do")}
                try:
                    changed = act(page, context, a) or {}
                    if "page" in changed:
                        page = changed.pop("page")
                    entry.update({"ok": True, **changed})
                except Exception as error:
                    entry.update({"ok": False, "error": (str(error).strip().splitlines() or ["failed"])[0][:300]})
                    result["actions"].append(entry)
                    break
                result["actions"].append(entry)
            if len(context.pages) > opened:
                # A click opened a new tab: carry on there.
                page = context.pages[-1]
                page.bring_to_front()
                settle(page, 4000)
        elif kind == "read":
            mode = command.get("mode", "elements")
            if mode == "outline":
                result["read"] = page.locator("body").aria_snapshot()[:14000]
            elif mode == "text":
                result["read"] = page.inner_text("body")[:15000]
            else:
                result["read"] = page.evaluate(ELEMENTS_JS, command.get("query") or "")
        elif kind == "script":
            result["printed"] = run_script(page, context, command["code"])
        elif kind == "export_state":
            context.storage_state(path=command["path"])
        elif kind == "evidence":
            os.makedirs(os.path.dirname(command["path"]), exist_ok=True)
            page.screenshot(path=command["path"], full_page=bool(command.get("full_page")))
            result["saved"] = command["path"]
    except Exception as error:
        result["error"] = (str(error).strip().splitlines() or ["failed"])[0][:400]
    if dialogs:
        result["dialogs"] = dialogs
    try:
        result.update({"url": page.url, "title": page.title(), "tabs": tabs(context, page)})
    except Exception:
        pass
    region = command.get("region")
    if command.get("screenshot", True):
        try:
            if region:
                from PIL import Image
                page.screenshot(path=shot_path + ".png", clip=region)
                image = Image.open(shot_path + ".png")
                scale = min(3, max(1, int(${VIEWPORT.width} / max(1, region["width"]))))
                image.resize((image.width * scale, image.height * scale)).convert("RGB").save(shot_path, "JPEG", quality=80)
            else:
                page.screenshot(path=shot_path, type="jpeg", quality=60)
        except Exception as error:
            result["screenshotError"] = str(error)[:200]
    with open(state_path, "w") as f:
        json.dump({"target": target_id(context, page)}, f)
with open(out_path, "w") as f:
    json.dump(result, f)
`;

export type BrowserAction = Record<string, unknown> & { do: string };

export type BrowserCommand =
  | { type: "act"; actions: BrowserAction[]; accept_dialogs?: boolean }
  | { type: "look"; region?: { x: number; y: number; width: number; height: number } }
  | { type: "read"; mode: "elements" | "outline" | "text"; query?: string }
  | { type: "script"; code: string }
  | { type: "export_state"; path: string }
  | { type: "evidence"; path: string; full_page?: boolean };

export type StepResult = {
  url?: string;
  title?: string;
  tabs?: { index: number; url: string; current: boolean }[];
  actions: { do: string; ok: boolean; error?: string; downloaded?: string }[];
  read?: unknown;
  printed?: string;
  saved?: string;
  dialogs?: { type: string; message: string }[];
  error?: string;
  screenshotError?: string;
  /** JPEG of what the browser shows now, base64. */
  screenshot?: string;
};

async function open(context: AgentContext): Promise<JobSandbox> {
  // The sandbox was started by the tool wrapper (startSandbox); this resumes it.
  return openCompanySandbox(context.organizationId, sandboxNameOf(context), async () => {});
}

/** Starts the browser if it isn't running (it stops with the sandbox). */
export async function ensureBrowser(sandbox: JobSandbox): Promise<void> {
  const alive = await sandbox.run("bash", ["-c", `[ -f ${READY} ] && kill -0 "$(cat ${READY})" 2>/dev/null && echo yes || echo no`]);
  if (alive.stdout.trim() === "yes") return;
  await sandbox.run("bash", ["-c", `mkdir -p ${PROFILE} ${JOB_DIR}/.mach && rm -f ${READY} ${PROFILE}/SingletonLock`]);
  await sandbox.writeFiles([
    { path: SERVER, content: Buffer.from(SERVER_PY) },
    { path: STEP, content: Buffer.from(STEP_PY) },
  ]);
  await sandbox.start("python3", [SERVER, PROFILE, String(PORT), READY], { cwd: JOB_DIR });
  const ready = await sandbox.run("bash", ["-c", `for _ in $(seq 1 40); do [ -f ${READY} ] && exit 0; sleep 0.5; done; exit 1`]);
  if (ready.exitCode !== 0) throw new Error("The browser didn't start.");
}

/** Runs one command in the browser and returns what happened, with a screenshot unless asked not to. */
export async function browserStep(context: AgentContext, command: BrowserCommand, { screenshot = true } = {}): Promise<StepResult> {
  "use step";
  const sandbox = await open(context);
  await ensureBrowser(sandbox);
  const id = crypto.randomUUID();
  const input = `/tmp/browser-${id}.json`;
  const output = `/tmp/browser-${id}.out.json`;
  const shot = `/tmp/browser-${id}.jpg`;
  const payload = command.type === "look" ? { type: "act", actions: [], region: command.region } : { ...command, screenshot };
  await sandbox.writeFiles([
    { path: STEP, content: Buffer.from(STEP_PY) },
    { path: input, content: Buffer.from(JSON.stringify(payload)) },
  ]);
  const run = await sandbox.run("python3", [STEP, input, output, shot], { cwd: JOB_DIR, timeoutMs: 150_000 });
  const raw = await sandbox.readFile(output);
  if (!raw) {
    const why = (run.stderr || run.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    return { actions: [], error: why || "The browser step failed." };
  }
  const result = JSON.parse(raw.toString("utf8")) as StepResult;
  const image = screenshot ? await sandbox.readFile(shot) : null;
  if (image) result.screenshot = image.toString("base64");
  await sandbox.run("rm", ["-f", input, output, shot, `${shot}.png`]);
  return result;
}

/** Closes the browser (its profile stays for next time). */
export async function closeBrowser(context: AgentContext): Promise<void> {
  "use step";
  const sandbox = await open(context);
  await sandbox.run("rm", ["-f", READY]);
}
