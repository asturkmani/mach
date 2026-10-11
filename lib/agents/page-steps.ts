import type { AgentContext } from "@/lib/agents/prompts";
import { appUrl } from "@/lib/app-url";
import { drivePath } from "@/lib/drive";
import { isMachSource } from "@/lib/mach-sources";
import { buildPageDocument } from "@/lib/page-frame";
import { getPage, pageDataStatus, pageHtml, PageError, readPageData, savePage, setPageRefresh, setPageVisibility, type PageAuthor } from "@/lib/pages";
import { JOB_DIR, openCompanySandbox, sandboxNameOf } from "@/lib/sandbox";
import { getSchedule } from "@/lib/schedules";

// The page tools' durable steps (lib/agents/page-tools.ts): saving a page,
// reading it, sharing it and keeping its data fresh. And the check: the
// browser in the agent's sandbox opens the page's document (with its data)
// and reports script errors, what rendered, and whether it fits a phone, so
// the agent can fix a broken page before anyone opens it.

const ago = (date: Date | null) => {
  if (!date) return "not on the drive yet";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  return minutes < 2 ? "updated just now" : minutes < 120 ? `updated ${minutes} min ago` : `updated ${Math.round(minutes / 60)} h ago`;
};

export type PageInput = { page?: string; title: string; description?: string; html: string; data: string[]; note?: string };

export type SavedPage =
  | { error: string }
  | {
      page: { slug: string; title: string; version: number; url: string; pinned: boolean };
      created: boolean;
      changed: boolean;
      data: { path: string; status: string }[];
      /** The document to check in the sandbox browser, when the HTML changed. */
      document: string | null;
    };

/** Saves a page, or a new version of one; refused when none of its data exists yet. */
export async function savePageStep(context: AgentContext, by: PageAuthor, input: PageInput): Promise<SavedPage> {
  "use step";
  const orgId = context.organizationId;
  try {
    // A page is a report on real data: refuse one whose data doesn't exist yet rather than save a placeholder.
    const data = input.data.map((path) => (isMachSource(path.trim()) ? path.trim() : drivePath(path)));
    const status = await pageDataStatus(orgId, { data });
    if (status.length === 0 || status.every((f) => !f.live && !f.updatedAt)) {
      return {
        error: `none of its data exists yet${data.length ? ` (${data.join(", ")} ${data.length === 1 ? "isn't" : "aren't"} on the drive)` : ""}. Get the data first (connect the system, run the script that writes the file), or tell them what's needed; don't build a placeholder page.`,
      };
    }
    const { page, created, changed } = await savePage(orgId, {
      slug: input.page,
      title: input.title,
      description: input.description,
      html: input.html,
      data: input.data,
      note: input.note ?? (input.page ? "" : "First version"),
      by,
    });
    const files = await readPageData(orgId, page);
    const document = changed
      ? buildPageDocument({
          html: (await pageHtml(orgId, page.slug))!.html,
          title: page.title,
          theme: "light",
          files: files.map((f) => ({ path: f.path, updatedAt: f.updatedAt?.toISOString() ?? null, value: f.value, problem: f.problem })),
        })
      : null;
    return {
      page: { slug: page.slug, title: page.title, version: page.version, url: appUrl(`/pages/${page.slug}`), pinned: page.pinned },
      created,
      changed,
      data: files.map((f) => ({ path: f.path, status: f.problem ?? ago(f.updatedAt) })),
      document,
    };
  } catch (error) {
    if (error instanceof PageError) return { error: error.message };
    if (error instanceof Error && /drive|path|name/i.test(error.message)) return { error: error.message };
    throw error;
  }
}

/** Shares a page with the company, or makes it private again: only for whoever made it. */
export async function sharePageStep(context: AgentContext, by: PageAuthor, slug: string, withCompany: boolean): Promise<string> {
  "use step";
  const page = await getPage(context.organizationId, slug, { viewer: by.personId });
  if (!page) return `There's no page called ${slug}.`;
  if (!by.personId || page.createdByPersonId !== by.personId) return `Only whoever made ${page.title}, or an admin in the app, can change who sees it.`;
  await setPageVisibility(context.organizationId, slug, withCompany ? "company" : "private");
  return withCompany ? `${page.title} is shared with the company.` : `${page.title} is private to whoever made it.`;
}

/** A page's HTML, the drive files it reads and what refreshes it. */
export async function readPageStep(context: AgentContext, by: PageAuthor, slug: string): Promise<string> {
  "use step";
  const page = await getPage(context.organizationId, slug, { viewer: by.personId });
  const html = page && (await pageHtml(context.organizationId, slug));
  if (!page || !html) return `There's no page called ${slug}.`;
  const schedule = page.taskId ? await getSchedule(page.taskId) : null;
  const files = await readPageData(context.organizationId, { data: page.data });
  return [
    `${page.title}, version ${html.version}. ${page.description}`,
    `Data: ${files.map((f) => `${f.path} (${f.problem ?? ago(f.updatedAt)})`).join(", ") || "none"}`,
    `Refreshed by: ${page.taskNumber ? `#${page.taskNumber}${schedule ? `, ${schedule.description}` : ""}` : "nothing yet"}`,
    "",
    html.html,
  ].join("\n");
}

/** Sets up (or changes) the quiet job that keeps a page's data fresh, and runs it once. */
export async function refreshPageStep(
  context: AgentContext,
  by: PageAuthor,
  slug: string,
  refresh: { command: string; cron: string; timezone: string },
): Promise<string> {
  "use step";
  try {
    const result = await setPageRefresh(context.organizationId, slug, refresh, { name: by.name, personId: by.personId });
    return `Job #${result.taskNumber} refreshes it ${result.schedule.description}, and is running once now. Runs that work stay quiet; a failure goes to an agent and then to them.`;
  } catch (error) {
    if (error instanceof PageError) return `Not set up: ${error.message}`;
    throw error;
  }
}

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
