import "server-only";

import { createHash } from "node:crypto";

import { getDb } from "@/lib/db";
import { drivePath } from "@/lib/drive";
import { saveVersion } from "@/lib/files";
import { isMachSource, MACH_SOURCES } from "@/lib/mach-data";
import { getSchedule, type Schedule } from "@/lib/schedules";
import { loadBytes } from "@/lib/storage";
import { getTask } from "@/lib/tasks";
import { archiveTask, createTaskWithTeam, rerunScript, scheduleTask, WorkError, type Actor } from "@/lib/work";

// Pages: views of the company's data that people ask the Chief of Staff for
// ("net worth by entity from Masttro, every morning"), shown as tabs on Home.
// A page is one HTML document, every version kept, that reads files on the
// company drive. It never fetches anything itself: it runs in a sandboxed
// frame with no network, and Mach hands it the data. A recurring job keeps
// the data fresh, replaying a script without a model, quietly unless it fails.

export type Page = {
  id: string;
  slug: string;
  title: string;
  description: string;
  /** What the page reads: drive paths ("masttro/holdings.json") and Mach's own data ("mach:tasks"). */
  data: string[];
  /** The job that refreshes its data, if it has one. */
  taskId: string | null;
  taskNumber: number | null;
  pinned: boolean;
  version: number;
  updatedAt: Date;
};

export type PageVersion = { version: number; note: string; byName: string; createdAt: Date };

/** A page's HTML can't be bigger than this. */
export const MAX_PAGE_HTML_BYTES = 1024 * 1024;
/** A page reads at most this many files, and this much data in all. */
export const MAX_PAGE_FILES = 20;
export const MAX_PAGE_DATA_BYTES = 8 * 1024 * 1024;

export class PageError extends Error {}

export function pageSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "page";
}

type PageRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  data: string[];
  task_id: string | null;
  task_number: number | null;
  pinned: boolean;
  version: number | null;
  updated_at: Date;
};

const SELECT = `select p.id, p.slug, p.title, p.description, p.data, p.task_id, t.number as task_number, p.pinned, p.updated_at,
  (select max(version) from page_versions v where v.page_id = p.id) as version
  from pages p left join tasks t on t.id = p.task_id`;

const toPage = (r: PageRow): Page => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  description: r.description,
  data: r.data,
  taskId: r.task_id,
  taskNumber: r.task_number,
  pinned: r.pinned,
  version: r.version ?? 0,
  updatedAt: r.updated_at,
});

/** The company's pages: pinned ones (Home's tabs) first, in the order they were made. */
export async function listPages(organizationId: string): Promise<Page[]> {
  const rows = await getDb().query<PageRow>(`${SELECT} where p.organization_id = $1 order by p.pinned desc, p.created_at`, [
    organizationId,
  ]);
  return rows.map(toPage);
}

export async function getPage(organizationId: string, slug: string): Promise<Page | null> {
  const [row] = await getDb().query<PageRow>(`${SELECT} where p.organization_id = $1 and p.slug = $2`, [organizationId, slug]);
  return row ? toPage(row) : null;
}

async function mustGet(organizationId: string, slug: string): Promise<Page> {
  const page = await getPage(organizationId, slug);
  if (!page) throw new PageError(`There's no page called ${slug}.`);
  return page;
}

/** A page's HTML: its latest version, or the one asked for. */
export async function pageHtml(organizationId: string, slug: string, version?: number): Promise<{ html: string; version: number } | null> {
  const [row] = await getDb().query<{ html: string; version: number }>(
    `select v.html, v.version from page_versions v join pages p on p.id = v.page_id
     where p.organization_id = $1 and p.slug = $2 and ($3::int is null or v.version = $3)
     order by v.version desc limit 1`,
    [organizationId, slug, version ?? null],
  );
  return row ?? null;
}

export async function listPageVersions(organizationId: string, slug: string): Promise<PageVersion[]> {
  const rows = await getDb().query<{ version: number; note: string; by_name: string; created_at: Date }>(
    `select v.version, v.note, v.by_name, v.created_at from page_versions v join pages p on p.id = v.page_id
     where p.organization_id = $1 and p.slug = $2 order by v.version desc`,
    [organizationId, slug],
  );
  return rows.map((r) => ({ version: r.version, note: r.note, byName: r.by_name, createdAt: r.created_at }));
}

export type PageAuthor = { name: string; personId?: string; agentId?: string };

/**
 * Creates a page, or saves a new version of one (when `slug` names an
 * existing page). Unchanged HTML adds no version. Its data must be drive paths.
 */
export async function savePage(
  organizationId: string,
  input: { slug?: string; title: string; description?: string; html: string; data: string[]; note?: string; by: PageAuthor },
): Promise<{ page: Page; created: boolean; changed: boolean }> {
  const title = input.title.trim();
  if (!title) throw new PageError("A page needs a title.");
  if (!input.html.trim()) throw new PageError("A page needs its HTML.");
  if (Buffer.byteLength(input.html) > MAX_PAGE_HTML_BYTES) throw new PageError("The page's HTML is larger than 1 MB. Keep data in drive files, not in the page.");
  let data: string[];
  try {
    data = [...new Set(input.data.map((path) => (isMachSource(path.trim()) ? path.trim() : drivePath(path))))];
  } catch (error) {
    throw new PageError(error instanceof Error ? error.message : String(error));
  }
  if (data.length > MAX_PAGE_FILES) throw new PageError(`A page can read at most ${MAX_PAGE_FILES} drive files.`);

  const db = getDb();
  let page = input.slug ? await getPage(organizationId, input.slug) : null;
  const created = !page;
  if (!page) {
    const base = pageSlug(input.slug || title);
    const taken = new Set(
      (await db.query<{ slug: string }>("select slug from pages where organization_id = $1 and slug like $2", [organizationId, `${base}%`])).map(
        (r) => r.slug,
      ),
    );
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const [row] = await db.query<{ id: string }>(
      `insert into pages (organization_id, slug, title, description, data, created_by_person_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [organizationId, slug, title, input.description?.trim() ?? "", data, input.by.personId ?? null],
    );
    page = { ...(await getPage(organizationId, slug))!, id: row.id };
  } else {
    await db.query(
      `update pages set title = $2, description = coalesce($3, description), data = $4, updated_at = now() where id = $1`,
      [page.id, title, input.description?.trim() ?? null, data],
    );
  }

  const sha256 = createHash("sha256").update(input.html).digest("hex");
  const [latest] = await db.query<{ version: number; sha256: string }>(
    "select version, sha256 from page_versions where page_id = $1 order by version desc limit 1",
    [page.id],
  );
  const changed = latest?.sha256 !== sha256;
  if (changed) {
    await db.query(
      `insert into page_versions (page_id, version, html, sha256, note, by_name, person_id, agent_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [page.id, (latest?.version ?? 0) + 1, input.html, sha256, input.note?.trim() ?? "", input.by.name, input.by.personId ?? null, input.by.agentId ?? null],
    );
    await db.query("update pages set updated_at = now() where id = $1", [page.id]);
  }
  return { page: (await getPage(organizationId, page.slug))!, created, changed };
}

/** Makes an old version the latest again (as a new version, so nothing is lost). */
export async function restorePageVersion(organizationId: string, slug: string, version: number, by: PageAuthor): Promise<Page> {
  const page = await mustGet(organizationId, slug);
  const old = await pageHtml(organizationId, slug, version);
  if (!old || old.version !== version) throw new PageError(`${page.title} has no version ${version}.`);
  const { page: saved } = await savePage(organizationId, {
    slug,
    title: page.title,
    html: old.html,
    data: page.data,
    note: `Back to version ${version}`,
    by,
  });
  return saved;
}

export async function setPinned(organizationId: string, slug: string, pinned: boolean): Promise<void> {
  await getDb().query("update pages set pinned = $3 where organization_id = $1 and slug = $2", [organizationId, slug, pinned]);
}

/** Deletes a page with its versions, and archives the job that refreshed it. Its data stays on the drive. */
export async function deletePage(organizationId: string, slug: string, by: Actor): Promise<void> {
  const page = await mustGet(organizationId, slug);
  await getDb().query("delete from pages where id = $1", [page.id]);
  if (page.taskId) {
    const task = await getTask(organizationId, page.taskId);
    if (task && !task.archivedAt) await archiveTask(organizationId, page.taskId, by);
  }
}

// ---------------------------------------------------------------------------
// Data: the drive files a page reads, handed to it when it opens.

export type PageDataFile = {
  path: string;
  /** Mach's own data (mach:tasks), read as the page opens: always current. */
  live?: boolean;
  /** When its content last changed. Null when the file isn't on the drive (yet), or it's live. */
  updatedAt: Date | null;
  size: number;
  /** JSON files arrive parsed, text files (CSV, Markdown…) as text. */
  value?: unknown;
  problem?: string;
};

const TEXT = /\.(csv|tsv|txt|md|html|xml|yaml|yml)$/i;

/** When each of a page's files last changed, without reading them. */
export async function pageDataStatus(organizationId: string, page: Pick<Page, "data">): Promise<PageDataFile[]> {
  if (page.data.length === 0) return [];
  const rows = await getDb().query<{ path: string; size: number; updated_at: Date }>(
    "select path, size, updated_at from drive_files where organization_id = $1 and path = any($2::text[])",
    [organizationId, page.data],
  );
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return page.data.map((path) => {
    if (isMachSource(path)) return { path, live: true, size: 0, updatedAt: null };
    const row = byPath.get(path);
    return row ? { path, size: row.size, updatedAt: row.updated_at } : { path, size: 0, updatedAt: null, problem: "Not on the drive yet." };
  });
}

/** A page's files with their content, within the page's data limit. */
export async function readPageData(organizationId: string, page: Pick<Page, "data">): Promise<PageDataFile[]> {
  const files = await pageDataStatus(organizationId, page);
  const rows = await getDb().query<{ path: string; blob_pathname: string | null; content: Uint8Array | null }>(
    "select path, blob_pathname, content from drive_files where organization_id = $1 and path = any($2::text[])",
    [organizationId, page.data],
  );
  const stored = new Map(rows.map((r) => [r.path, r]));
  let budget = MAX_PAGE_DATA_BYTES;
  for (const file of files) {
    if (file.live && isMachSource(file.path)) {
      file.value = await MACH_SOURCES[file.path].load(organizationId);
      continue;
    }
    const row = stored.get(file.path);
    if (!row || file.problem) continue;
    if (file.size > budget) {
      file.problem = "Too big to hand to a page: save a smaller summary file for it.";
      continue;
    }
    budget -= file.size;
    const text = (await loadBytes(row)).toString("utf8");
    if (/\.json$/i.test(file.path)) {
      try {
        file.value = JSON.parse(text);
      } catch {
        file.problem = "Not valid JSON.";
        file.value = text;
      }
    } else if (TEXT.test(file.path)) {
      file.value = text;
    } else {
      file.problem = "Pages read JSON and text files (CSV, Markdown); this one is neither.";
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Refreshing: a quiet recurring job whose run.sh runs the command that writes
// the page's data. Successful runs leave the job done; a failure wakes its agent.

export type PageRefresh = { command: string; cron: string; timezone: string };

const runScript = (command: string, title: string) =>
  `#!/usr/bin/env bash
# Refreshes the data for the "${title.replace(/["\\\n]/g, "")}" page.
set -euo pipefail
${command.trim()}
echo "SUMMARY: Refreshed the data for the page."
`;

/**
 * Sets up (or changes) the job that keeps a page's data fresh, and runs it
 * once now so it's known to work in its own sandbox.
 */
export async function setPageRefresh(
  organizationId: string,
  slug: string,
  refresh: PageRefresh,
  by: Actor,
): Promise<{ taskId: string; taskNumber: number; schedule: Schedule }> {
  const page = await mustGet(organizationId, slug);
  const command = refresh.command.trim();
  if (!command) throw new PageError("Give the command that writes the page's data, e.g. python3 /vercel/drive/pages/net-worth/refresh.py.");
  if (command.length > 2000) throw new PageError("Keep the command short: put the work in a script on the drive and run that.");

  let task = page.taskId ? await getTask(organizationId, page.taskId) : null;
  if (task?.archivedAt || task?.status === "cancelled") task = null;
  const description = [
    `Keeps the data of the **${page.title}** page fresh. run.sh runs \`${command.split("\n")[0]}\`, which writes ${
      page.data.filter((p) => !isMachSource(p)).map((p) => `/vercel/drive/${p}`).join(", ") || "the page's files on the drive"
    }.`,
    "",
    "Runs are quiet: they only reach people when one fails. If a run fails, find out why, fix the script, run it, and check it still writes the same files in the same shape, because the page reads them.",
  ].join("\n");
  try {
    if (!task) {
      task = await createTaskWithTeam(organizationId, {
        title: `Refresh page: ${page.title}`.slice(0, 100),
        description,
        status: "backlog",
        workerRole: "Page data refresh",
        by,
      });
      await getDb().query("update pages set task_id = $2 where id = $1", [page.id, task.id]);
    }
    await saveVersion(organizationId, {
      name: "run.sh",
      kind: "code",
      bytes: Buffer.from(runScript(command, page.title)),
      taskId: task.id,
      note: "Written for the page's data refresh.",
    });
    const schedule = await scheduleTask(organizationId, task.id, by, {
      cron: refresh.cron,
      timezone: refresh.timezone,
      mode: "script",
      quiet: true,
    });
    await rerunScript(organizationId, task.id, by);
    return { taskId: task.id, taskNumber: task.number, schedule: (await getSchedule(task.id)) ?? schedule };
  } catch (error) {
    if (error instanceof WorkError) throw new PageError(error.message);
    throw error;
  }
}
