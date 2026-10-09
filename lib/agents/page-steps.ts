import type { AgentContext } from "@/lib/agents/prompts";
import { JOB_DIR, openCompanySandbox, sandboxNameOf } from "@/lib/sandbox";

// Checks a page the way people will see it: the browser in the agent's
// sandbox opens the page's document (with its data) and reports script
// errors, what rendered, and whether it fits a phone, so the agent can fix a
// broken page before anyone opens it.

const CHECKER = `${JOB_DIR}/.mach/check-page.py`;

const CHECK_PY = String.raw`# Opens a page's document and reports what rendered. Written by Mach1.
import json, sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

doc_path, out_path = sys.argv[1], sys.argv[2]
ALLOWED = ("file://", "data:", "blob:", "https://cdn.jsdelivr.net/", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/")
SUMMARY = r"""() => {
  const body = document.body;
  const text = body ? body.innerText.replace(/\n{3,}/g, "\n\n").trim() : "";
  return {
    title: document.title,
    text: text.slice(0, 2500),
    textLength: text.length,
    headings: [...document.querySelectorAll("h1,h2,h3")].slice(0, 20).map(h => h.innerText.trim().slice(0, 80)),
    tables: [...document.querySelectorAll("table")].map(t => t.rows.length),
    charts: document.querySelectorAll("svg, canvas").length,
    width: document.documentElement.scrollWidth,
  };
}"""
result = {"errors": [], "blocked": []}
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, size in (("desktop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})):
        page = browser.new_page(viewport=size)
        def route(r):
            if r.request.url.startswith(ALLOWED):
                r.continue_()
            else:
                if r.request.url not in result["blocked"]:
                    result["blocked"].append(r.request.url[:200])
                r.abort()
        page.route("**/*", route)
        if name == "desktop":
            page.on("pageerror", lambda e: result["errors"].append(str(e)[:400]))
            page.on("console", lambda m: m.type == "error" and result["errors"].append(m.text[:400]))
        try:
            page.goto("file://" + doc_path, wait_until="load", timeout=20000)
            page.wait_for_load_state("networkidle", timeout=8000)
        except PlaywrightTimeout:
            pass
        page.wait_for_timeout(500)
        summary = page.evaluate(SUMMARY)
        if name == "desktop":
            result.update(summary)
        else:
            result["phoneWidth"] = summary["width"]
        page.close()
    browser.close()
with open(out_path, "w") as f:
    json.dump(result, f)
`;

export type PageCheck = {
  errors: string[];
  blocked: string[];
  title: string;
  text: string;
  textLength: number;
  headings: string[];
  tables: number[];
  charts: number;
  width: number;
  phoneWidth: number;
};

/** Opens a page's built document in the agent's sandbox browser. Null if the browser couldn't run. */
export async function checkPage(context: AgentContext, document: string): Promise<PageCheck | null> {
  "use step";
  const sandbox = await openCompanySandbox(context.organizationId, sandboxNameOf(context), async () => {});
  const id = crypto.randomUUID();
  const doc = `/tmp/mach-page-${id}.html`;
  const out = `/tmp/mach-page-${id}.json`;
  await sandbox.run("mkdir", ["-p", `${JOB_DIR}/.mach`]);
  await sandbox.writeFiles([
    { path: CHECKER, content: Buffer.from(CHECK_PY) },
    { path: doc, content: Buffer.from(document) },
  ]);
  const run = await sandbox.run("python3", [CHECKER, doc, out], { cwd: JOB_DIR, timeoutMs: 90_000 });
  const raw = await sandbox.readFile(out);
  await sandbox.run("rm", ["-f", doc, out]);
  if (!raw) {
    console.error("The page check didn't run", run.stderr.slice(-500));
    return null;
  }
  return JSON.parse(raw.toString("utf8")) as PageCheck;
}

/** What the agent reads about its page after saving it. */
export function describeCheck(check: PageCheck): string {
  const problems = [
    ...check.errors.map((e) => `Script error: ${e}`),
    ...check.blocked.map((url) => `Blocked request (pages can't load anything but their data, scripts from cdn.jsdelivr.net and Google Fonts): ${url}`),
    check.textLength === 0 && check.charts === 0 ? "Nothing rendered: the page is blank." : "",
    check.phoneWidth > 391 ? `It's ${check.phoneWidth}px wide on a 390px phone: wrap or scroll wide parts (tables in .table-wrap).` : "",
  ].filter(Boolean);
  const shape = [
    check.headings.length ? `Headings: ${check.headings.join(" / ")}` : "",
    check.tables.length ? `Tables: ${check.tables.map((rows) => `${rows} rows`).join(", ")}` : "",
    check.charts ? `Charts (svg or canvas): ${check.charts}` : "",
  ].filter(Boolean);
  return [
    problems.length ? `The check found problems; fix them and save again:\n${problems.map((p) => `- ${p}`).join("\n")}` : "The check found no script errors.",
    shape.join("\n"),
    `What it shows (first part):\n${check.text.slice(0, 1500) || "(no text)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
