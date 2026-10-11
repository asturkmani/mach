import { beforeEach, describe, expect, it } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { runAgentOnTask } from "@/lib/agents/runner";
import { workerAgent } from "@/lib/agents/store";
import { readDriveFile, writeDriveFile } from "@/lib/drive";
import { listTaskFiles, readVersion } from "@/lib/files";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { buildPageDocument, scriptJson } from "@/lib/page-frame";
import {
  getPage,
  listPages,
  listPageVersions,
  pageHtml,
  PageError,
  readPageData,
  restorePageVersion,
  savePage,
} from "@/lib/pages";
import { linkMember, savePerson } from "@/lib/people";
import { pageDataStatus } from "@/lib/pages";
import { setSandboxProvider } from "@/lib/sandbox";
import { getSchedule } from "@/lib/schedules";
import { createTask, getTask, listInbox, listMessages } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { fakeSandboxes } from "@/test/fake-sandbox";
import { scriptedModel, type Step } from "@/test/scripted-model";

const ORG = "org_cedar";
const DATA = "pages/net-worth/data.json";
const by = { name: "Ahmed" };

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><title>Net worth</title></head>
<body>
<h1>Net worth</h1>
<div class="stats"><div class="stat"><span class="label">Total</span><span class="value" id="total"></span></div></div>
<script>
  const data = mach.data["${DATA}"];
  document.getElementById("total").textContent = data ? mach.money(data.total) : "No data yet";
</script>
</body></html>`;

/** A Masttro-like source, faked: the refresh script writes net worth by entity to the drive. */
function netWorthSandboxes() {
  const seen: { checked?: string; refreshes: number; failNext: boolean } = { refreshes: 0, failNext: false };
  const write = (files: Map<string, Buffer>, total: number) =>
    files.set(
      `/vercel/drive/${DATA}`,
      Buffer.from(JSON.stringify({ as_of: "2026-10-08T07:00:00Z", total, entities: [{ name: "Cedar Holdings", value: total }] })),
    );
  const sandboxes = fakeSandboxes({
    "refresh.py": (files) => {
      write(files, 41_200_000);
      return { stdout: "wrote pages/net-worth/data.json" };
    },
    "run.sh": (files) => {
      if (seen.failNext) {
        seen.failNext = false;
        return { exitCode: 1, stderr: "masttro returned 401" };
      }
      seen.refreshes++;
      write(files, 41_500_000 + seen.refreshes);
      return { stdout: "SUMMARY: Refreshed the data for the page.\n" };
    },
    "check-page.py": (files, [doc, out]) => {
      seen.checked = files.get(doc)!.toString();
      files.set(
        out,
        Buffer.from(
          JSON.stringify({
            errors: [],
            blocked: [],
            title: "Net worth",
            text: "Net worth\nTotal\n$41.2M",
            textLength: 24,
            headings: ["Net worth"],
            tables: [],
            charts: 0,
            width: 1280,
            phoneWidth: 390,
          }),
        ),
      );
    },
  });
  return { sandboxes, seen };
}

/** Runs started by the app (the refresh job's runs), collected so a test can wait for them. */
function captureRuns(steps: Step[] = [new Error("A refresh that works doesn't need a model.")]) {
  const runs: Promise<void>[] = [];
  setScheduler((work) => runs.push(work()), { model: scriptedModel(steps), research: false });
  return { settle: async () => void (await Promise.all(runs.splice(0))) };
}

describe("pages", () => {
  beforeEach(async () => {
    setScheduler(null);
    setSandboxProvider(null);
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("are built by the Worker from a data source, checked in its browser, and kept fresh by a quiet job", async () => {
    const person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const { sandboxes, seen } = netWorthSandboxes();
    setSandboxProvider(sandboxes.provider);
    const runs = captureRuns();

    // The Chief of Staff hands it on with spawn_worker and building-pages; the Worker builds it.
    const worker = await workerAgent(ORG);
    const task = await createTask(ORG, {
      title: "Build a net worth page",
      description: "Net worth by entity from Masttro, refreshed every weekday at 7am.",
      people: [person.id],
      agents: [worker.id],
      skills: ["building-pages"],
      createdBy: { personId: person.id },
    });
    const model = scriptedModel([
      [["write_file", { path: "/vercel/drive/pages/net-worth/refresh.py", content: "import requests  # calls Masttro" }]],
      [["run_code", { filename: "refresh.py", language: "python", code: "exec(open('/vercel/drive/pages/net-worth/refresh.py').read())" }]],
      [["save_page", { title: "Net worth", description: "Net worth by entity, from Masttro.", html: PAGE_HTML, data: [DATA] }]],
      [["refresh_page", { page: "net-worth", command: "python3 /vercel/drive/pages/net-worth/refresh.py", cron: "0 7 * * 1-5", timezone: "Europe/London" }]],
      [["finish", { summary: "Your Net worth page is up: $41.2M.", report: "It's in Pages and refreshes every weekday at 07:00: /pages/net-worth" }]],
    ]);
    await runAgentOnTask(ORG, task.id, worker.id, { model, research: false });
    const said = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));

    // The script ran in the task's sandbox and its output is on the drive; the page reads it, and it's Ahmed's.
    expect(JSON.parse((await readDriveFile(ORG, DATA))!.bytes.toString()).total).toBe(41_200_000);
    const page = (await getPage(ORG, "net-worth"))!;
    expect(page).toMatchObject({ title: "Net worth", data: [DATA], pinned: true, version: 1, createdByPersonId: person.id, visibility: "private" });

    // It was checked in the task's sandbox browser, with the data put in front of it, and the Worker saw the result and the link.
    expect(sandboxes.log).toContain(`create mach-task-${task.id}`);
    expect(seen.checked).toContain('"total":41200000');
    expect(seen.checked).toContain("<style data-mach-kit>");
    expect(said[3]).toContain("Created Net worth (net-worth), version 1: http://localhost:3000/pages/net-worth (give them this link in your report).");
    expect(said[3]).toContain("The check found no script errors.");

    // The refresh job: a quiet, scripted schedule whose run.sh runs the command, run once straight away.
    const job = (await getTask(ORG, page.taskId!))!;
    expect(job.title).toBe("Refresh page: Net worth");
    expect(await getSchedule(job.id)).toMatchObject({ cron: "0 7 * * 1-5", timezone: "Europe/London", mode: "script", quiet: true });
    const runSh = (await listTaskFiles(ORG, job.id)).find((f) => f.name === "run.sh")!;
    expect((await readVersion(ORG, runSh.versions[0].id))!.bytes.toString()).toContain("python3 /vercel/drive/pages/net-worth/refresh.py");
    await runs.settle();
    expect(seen.refreshes).toBe(1);
    expect(JSON.parse((await readDriveFile(ORG, DATA))!.bytes.toString()).total).toBe(41_500_001);

    // A run that works leaves the job done: only the Worker's report lands in Ahmed's inbox.
    expect((await getTask(ORG, job.id))!.status).toBe("done");
    expect((await listInbox(ORG, person.id)).map((t) => t.id)).toEqual([task.id]);

    // A run that fails wakes the job's agent, and what it reports reaches Ahmed.
    seen.failNext = true;
    const fix = captureRuns([[["finish", { summary: "Masttro's key was revoked: re-enter it on Integrations.", report: "The key was revoked." }]]]);
    const { rerunScript } = await import("@/lib/work");
    await rerunScript(ORG, job.id, { name: "Ahmed", personId: person.id });
    await fix.settle();
    const thread = await listMessages(job.id);
    expect(thread.some((m) => m.body.includes("run.sh failed") && m.body.includes("masttro returned 401"))).toBe(true);
    expect((await listInbox(ORG, person.id)).map((t) => t.id)).toContain(job.id);
  });

  it("aren't saved without real data: the Worker is told what's missing instead", async () => {
    const person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const worker = await workerAgent(ORG);
    const task = await createTask(ORG, { title: "Build a cash page", people: [person.id], agents: [worker.id], skills: ["building-pages"], createdBy: { personId: person.id } });
    const model = scriptedModel([
      [["save_page", { title: "Cash across banks", html: "<p>Awaiting data</p>", data: ["pages/bank-cash/data.json"] }]],
      [["ask", { summary: "Connect your bank first?", question: "There's no cash data yet: connect your bank or Masttro first." }]],
    ]);
    await runAgentOnTask(ORG, task.id, worker.id, { model, research: false });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("Not saved: none of its data exists yet");
    expect(await listPages(ORG)).toEqual([]);
  });

  it("aren't the Chief of Staff's to build: it has no page tools, and hands pages to the Worker", async () => {
    const person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const model = scriptedModel(["On it."]);
    await createChiefOfStaff(
      { organization, user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" }, person, profile: "" },
      { model, research: false },
    ).generate({ prompt: "Build me a page of our net worth." });
    const offered = (model.doGenerateCalls[0].tools ?? []).map((t) => t.name);
    expect(offered).toContain("spawn_worker");
    expect(offered.filter((n) => ["save_page", "read_page", "refresh_page", "share_page", "use_browser"].includes(n))).toEqual([]);
  });

  it("keep every version, skip unchanged saves and can go back to an old one", async () => {
    const first = await savePage(ORG, { title: "Net worth", html: "<p>one</p>", data: [`/vercel/drive/${DATA}`], by });
    expect(first).toMatchObject({ created: true, changed: true });
    expect(first.page).toMatchObject({ slug: "net-worth", data: [DATA], version: 1 });

    expect((await savePage(ORG, { slug: "net-worth", title: "Net worth", html: "<p>one</p>", data: [DATA], by })).changed).toBe(false);
    await savePage(ORG, { slug: "net-worth", title: "Net worth", html: "<p>two</p>", data: [DATA], note: "Added entities", by });
    expect((await listPageVersions(ORG, "net-worth")).map((v) => [v.version, v.note])).toEqual([
      [2, "Added entities"],
      [1, ""],
    ]);

    await restorePageVersion(ORG, "net-worth", 1, by);
    expect(await pageHtml(ORG, "net-worth")).toEqual({ html: "<p>one</p>", version: 3 });
    expect((await pageHtml(ORG, "net-worth", 2))!.html).toBe("<p>two</p>");

    // A second page with the same title gets its own slug; data must be on the drive.
    expect((await savePage(ORG, { title: "Net worth", html: "<p>x</p>", data: [], by })).page.slug).toBe("net-worth-2");
    await expect(savePage(ORG, { title: "Bad", html: "<p>x</p>", data: ["../secrets.json"], by })).rejects.toThrow(PageError);
    expect((await listPages(ORG)).map((p) => p.slug)).toEqual(["net-worth", "net-worth-2"]);
  });

  it("hand a page its data: JSON parsed, CSV as text, and say what's missing", async () => {
    await writeDriveFile(ORG, { path: DATA, bytes: Buffer.from('{"total": 5}') });
    await writeDriveFile(ORG, { path: "pages/net-worth/entities.csv", bytes: Buffer.from("name,value\nCedar,5\n") });
    await writeDriveFile(ORG, { path: "pages/net-worth/broken.json", bytes: Buffer.from("{oops") });
    const files = await readPageData(ORG, {
      data: [DATA, "pages/net-worth/entities.csv", "pages/net-worth/broken.json", "pages/net-worth/later.json"],
    });
    expect(files.map((f) => [f.path, f.value, f.problem])).toEqual([
      [DATA, { total: 5 }, undefined],
      ["pages/net-worth/entities.csv", "name,value\nCedar,5\n", undefined],
      ["pages/net-worth/broken.json", "{oops", "Not valid JSON."],
      ["pages/net-worth/later.json", undefined, "Not on the drive yet."],
    ]);
  });

  it("read Mach1's own tasks and people live, with no script or refresh job", async () => {
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    await savePerson(ORG, { name: "Sara", role: "Analyst", managerName: "Ahmed", email: "sara@cedar.example", phone: "+44 7700 900999" });
    await createTask(ORG, { title: "Close the Q3 books", priority: "high", people: [ahmed.id] });
    const { page } = await savePage(ORG, { title: "Team work", html: "<p>work</p>", data: ["mach:tasks", "mach:people"], by });
    expect(page.data).toEqual(["mach:tasks", "mach:people"]);
    expect((await pageDataStatus(ORG, page)).map((f) => [f.path, f.live])).toEqual([
      ["mach:tasks", true],
      ["mach:people", true],
    ]);

    const [tasks, people] = await readPageData(ORG, page);
    expect(tasks.value).toEqual([
      expect.objectContaining({ number: 1, title: "Close the Q3 books", status: "ready", priority: "high", people: ["Ahmed"], url: "/tasks/1" }),
    ]);
    // A task made after the page was saved is there the next time it opens.
    await createTask(ORG, { title: "Chase the auditors" });
    expect(((await readPageData(ORG, page))[0].value as { title: string }[]).map((t) => t.title)).toContain("Chase the auditors");
    // People without their contact details.
    expect(people.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Sara", role: "Analyst", reportsTo: "Ahmed", status: "not_invited" })]),
    );
    expect(JSON.stringify(people.value)).not.toMatch(/sara@|7700/);

    await expect(savePage(ORG, { title: "Bad", html: "<p>x</p>", data: ["mach:secrets"], by })).rejects.toThrow(PageError);
  });

  it("run as a document with Mach1's look and data in front of their own HTML", () => {
    const files = [{ path: DATA, updatedAt: "2026-10-08T07:00:00.000Z", value: { note: "</script><script>alert(1)</script>" } }];
    const full = buildPageDocument({ html: PAGE_HTML.replace("<html lang=\"en\">", '<html lang="en" data-theme="dark">'), title: "Net worth", theme: "light", files });
    expect(full.indexOf("<style data-mach-kit>")).toBeLessThan(full.indexOf("<title>Net worth</title>"));
    expect(full).toContain('<html lang="en" data-theme="light">');
    expect(full).not.toContain("</script><script>alert(1)");
    expect(full).toContain("\\u003c/script\\u003e");
    // Links to the app's own pages (a task's url) are handed to the app to open.
    expect(full).toContain('postMessage({ type: "mach:open"');

    // A fragment becomes a whole document; the system theme leaves the choice to the browser.
    const fragment = buildPageDocument({ html: "<h1>Hi</h1>", title: "Hi", theme: "system", files: [] });
    expect(fragment).toMatch(/^<!doctype html>\n<html lang="en">\n<head>/);
    expect(fragment).toContain("<body>\n<h1>Hi</h1>");
    expect(JSON.parse(scriptJson("a\u2028b</script>").replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"))).toBe("a\u2028b</script>");
  });
});
