import "server-only";

import { createHash } from "node:crypto";

import { getDb } from "@/lib/db";
import { visibleTo } from "@/lib/tasks";
import { loadBytes, removeBytes, storeBytes } from "@/lib/storage";

// The company file library. Every deliverable an agent attaches and every
// script it runs is a file with versions; jobs list the files they work with
// (inputs someone attached, outputs they produced). Content lives in Vercel
// Blob when a store is connected (BLOB_READ_WRITE_TOKEN), else in Postgres.

export type FileKind = "deliverable" | "code";

export type FileVersion = {
  id: string;
  version: number;
  contentType: string;
  size: number;
  taskId: string | null;
  taskNumber: number | null;
  agentName: string | null;
  basedOn: number | null;
  note: string;
  createdAt: Date;
};

export type LibraryFile = {
  id: string;
  name: string;
  kind: FileKind;
  updatedAt: Date;
  /** Newest first. */
  versions: FileVersion[];
  /** The company's, or (private) its owner's and visible on the tasks it's on. */
  visibility: "company" | "private";
  ownerPersonId: string | null;
};

/**
 * Whether the person in parameter `param` may see file f: a company file, one
 * they own, or one on a task they may see.
 */
const fileVisibleTo = (param: string) => `(f.visibility = 'company' or f.owner_person_id = ${param}
  or exists (select 1 from task_files vf join tasks t on t.id = vf.task_id where vf.file_id = f.id and ${visibleTo(param)}))`;

export type TaskFile = LibraryFile & { role: "input" | "output" };

/** Files larger than this aren't stored. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  parquet: "application/vnd.apache.parquet",
  zip: "application/zip",
  xml: "application/xml",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/typescript",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  yaml: "text/yaml",
  yml: "text/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function contentTypeFor(name: string): string {
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function isText(contentType: string): boolean {
  return contentType.startsWith("text/") || ["application/json"].includes(contentType);
}

// ---------------------------------------------------------------------------
// Reading

type VersionRow = {
  file_id: string;
  id: string;
  version: number;
  content_type: string;
  size: number;
  task_id: string | null;
  task_number: number | null;
  agent_name: string | null;
  based_on: number | null;
  note: string;
  created_at: Date;
};

const VERSION_COLUMNS = `v.file_id, v.id, v.version, v.content_type, v.size, v.task_id, t.number as task_number,
  a.name as agent_name, v.based_on, v.note, v.created_at`;

async function versionsOf(fileIds: string[]): Promise<Map<string, FileVersion[]>> {
  const byFile = new Map<string, FileVersion[]>();
  if (fileIds.length === 0) return byFile;
  const rows = await getDb().query<VersionRow>(
    `select ${VERSION_COLUMNS} from file_versions v
     left join tasks t on t.id = v.task_id
     left join agents a on a.id = v.agent_id
     where v.file_id = any($1::uuid[]) order by v.version desc`,
    [fileIds],
  );
  for (const r of rows) {
    const version: FileVersion = {
      id: r.id,
      version: r.version,
      contentType: r.content_type,
      size: r.size,
      taskId: r.task_id,
      taskNumber: r.task_number,
      agentName: r.agent_name,
      basedOn: r.based_on,
      note: r.note,
      createdAt: r.created_at,
    };
    byFile.set(r.file_id, [...(byFile.get(r.file_id) ?? []), version]);
  }
  return byFile;
}

type FileRow = {
  id: string;
  name: string;
  kind: FileKind;
  updated_at: Date;
  visibility: "company" | "private";
  owner_person_id: string | null;
  role?: "input" | "output";
};

export async function listTaskFiles(organizationId: string, taskId: string): Promise<TaskFile[]> {
  const rows = await getDb().query<FileRow>(
    `select f.id, f.name, f.kind, f.updated_at, f.visibility, f.owner_person_id, tf.role from task_files tf
     join files f on f.id = tf.file_id
     where tf.task_id = $1 and f.organization_id = $2
     order by (f.kind = 'code'), tf.added_at`,
    [taskId, organizationId],
  );
  const versions = await versionsOf(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    updatedAt: r.updated_at,
    role: r.role ?? "output",
    versions: versions.get(r.id) ?? [],
    visibility: r.visibility,
    ownerPersonId: r.owner_person_id,
  }));
}

/** The library (what the viewer may see, if given), newest first. */
export async function listLibrary(organizationId: string, { limit = 200, viewer }: { limit?: number; viewer?: string } = {}): Promise<LibraryFile[]> {
  const rows = await getDb().query<FileRow>(
    `select f.id, f.name, f.kind, f.updated_at, f.visibility, f.owner_person_id from files f
     where f.organization_id = $1 and ($3::uuid is null or ${fileVisibleTo("$3")})
     order by f.updated_at desc limit $2`,
    [organizationId, limit, viewer ?? null],
  );
  const versions = await versionsOf(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    updatedAt: r.updated_at,
    versions: versions.get(r.id) ?? [],
    visibility: r.visibility,
    ownerPersonId: r.owner_person_id,
  }));
}

/** Whether this person may open this version (its file is theirs, the company's, or on a task they can see). */
export async function canReadVersion(organizationId: string, versionId: string, personId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return false;
  const [row] = await getDb().query(
    `select 1 from file_versions v join files f on f.id = v.file_id
     where v.id = $1 and f.organization_id = $2 and ${fileVisibleTo("$3")}`,
    [versionId, organizationId, personId],
  );
  return Boolean(row);
}

/** Shares a file with the company, or makes it private to its owner (and the tasks it's on). */
export async function setFileVisibility(organizationId: string, fileId: string, visibility: "company" | "private"): Promise<void> {
  await getDb().query("update files set visibility = $3, updated_at = now() where organization_id = $1 and id = $2", [
    organizationId,
    fileId,
    visibility,
  ]);
}

/** One version with its content, if it belongs to this organization. */
export async function readVersion(
  organizationId: string,
  versionId: string,
): Promise<{ name: string; kind: FileKind; version: number; contentType: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return null;
  const [row] = await getDb().query<{
    name: string;
    kind: FileKind;
    version: number;
    content_type: string;
    blob_pathname: string | null;
    content: Uint8Array | null;
  }>(
    `select f.name, f.kind, v.version, v.content_type, v.blob_pathname, v.content from file_versions v
     join files f on f.id = v.file_id where v.id = $1 and f.organization_id = $2`,
    [versionId, organizationId],
  );
  if (!row) return null;
  return { name: row.name, kind: row.kind, version: row.version, contentType: row.content_type, bytes: await loadBytes(row) };
}

/** The latest version of each of a job's files, with content: what a fresh sandbox is seeded with. */
export async function readTaskFiles(
  organizationId: string,
  taskId: string,
): Promise<{ name: string; kind: FileKind; role: "input" | "output"; version: number; bytes: Buffer }[]> {
  const files = await listTaskFiles(organizationId, taskId);
  const out = [];
  for (const file of files) {
    const latest = file.versions[0];
    if (!latest) continue;
    const content = await readVersion(organizationId, latest.id);
    if (content) out.push({ name: file.name, kind: file.kind, role: file.role, version: latest.version, bytes: content.bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing

export type SaveVersionInput = {
  name: string;
  kind: FileKind;
  bytes: Buffer;
  contentType?: string;
  /** Saves a new version of this file; otherwise a file of the same name on the task, else a new file. */
  fileId?: string;
  taskId?: string;
  agentId?: string;
  personId?: string;
  note?: string;
  /** How a new file joins the task: an input someone gave it, or an output it produced (the default). */
  role?: "input" | "output";
};

export type SavedVersion = { fileId: string; versionId: string; version: number; basedOn: number | null; unchanged: boolean };

export async function saveVersion(organizationId: string, input: SaveVersionInput): Promise<SavedVersion> {
  const name = input.name.trim().split("/").pop()!;
  if (!name) throw new Error("A file needs a name.");
  if (input.bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const db = getDb();
  const contentType = input.contentType ?? contentTypeFor(name);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  let fileId = input.fileId;
  if (!fileId && input.taskId) {
    const [existing] = await db.query<{ id: string }>(
      `select f.id from task_files tf join files f on f.id = tf.file_id
       where tf.task_id = $1 and f.organization_id = $2 and lower(f.name) = lower($3) and f.kind = $4`,
      [input.taskId, organizationId, name, input.kind],
    );
    fileId = existing?.id;
  }
  if (!fileId) {
    // A task's file is seen by whoever can see the task; one someone added outside a task is theirs.
    const [task] = input.taskId
      ? await db.query<{ created_by_person_id: string | null }>("select created_by_person_id from tasks where id = $1", [input.taskId])
      : [];
    const owner = task ? task.created_by_person_id : (input.personId ?? null);
    const [created] = await db.query<{ id: string }>(
      "insert into files (organization_id, name, kind, visibility, owner_person_id) values ($1, $2, $3, $4, $5) returning id",
      [organizationId, name, input.kind, task || input.personId ? "private" : "company", owner],
    );
    fileId = created.id;
  } else {
    const [owned] = await db.query("select 1 from files where id = $1 and organization_id = $2", [fileId, organizationId]);
    if (!owned) throw new Error("That file isn't in this company's library.");
  }

  const [latest] = await db.query<{ id: string; version: number; sha256: string }>(
    "select id, version, sha256 from file_versions where file_id = $1 order by version desc limit 1",
    [fileId],
  );
  if (input.taskId) {
    await db.query(
      "insert into task_files (task_id, file_id, role) values ($1, $2, $3) on conflict (task_id, file_id) do nothing",
      [input.taskId, fileId, input.role ?? "output"],
    );
  }
  if (latest && latest.sha256 === sha256) {
    // A script that ran again keeps its latest run's output; a deliverable keeps the note it was made with.
    if (input.note && input.kind === "code") await db.query("update file_versions set note = $2 where id = $1", [latest.id, input.note]);
    return { fileId, versionId: latest.id, version: latest.version, basedOn: null, unchanged: true };
  }

  const version = (latest?.version ?? 0) + 1;
  // Versions never change, so each has its own fixed pathname.
  const stored = await storeBytes(`orgs/${organizationId}/files/${fileId}/v${version}/${name}`, input.bytes, contentType);
  const [row] = await db.query<{ id: string }>(
    `insert into file_versions (file_id, version, content_type, size, sha256, blob_pathname, content, task_id, agent_id,
                                person_id, based_on, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [
      fileId,
      version,
      contentType,
      input.bytes.length,
      sha256,
      stored.blobPathname,
      stored.content,
      input.taskId ?? null,
      input.agentId ?? null,
      input.personId ?? null,
      latest?.version ?? null,
      input.note ?? "",
    ],
  );
  await db.query("update files set updated_at = now() where id = $1", [fileId]);
  return { fileId, versionId: row.id, version, basedOn: latest?.version ?? null, unchanged: false };
}

// ---------------------------------------------------------------------------
// Files people attach in a task's thread go straight from the browser to Blob,
// under this prefix, and are then taken into the library.

export const uploadsPrefix = (organizationId: string) => `orgs/${organizationId}/uploads/`;

/** Reads a browser upload, which must be this company's. */
export async function readUpload(organizationId: string, blobPathname: string): Promise<Buffer> {
  const prefix = uploadsPrefix(organizationId);
  if (!blobPathname.startsWith(prefix) || blobPathname.slice(prefix.length).includes("/")) {
    throw new Error("That upload isn't this company's.");
  }
  return loadBytes({ blob_pathname: blobPathname, content: null });
}

/** Deletes browser uploads once they're in the library, which keeps its own copy. */
export async function discardUploads(organizationId: string, blobPathnames: string[]): Promise<void> {
  const prefix = uploadsPrefix(organizationId);
  await Promise.all(blobPathnames.filter((p) => p.startsWith(prefix)).map((p) => removeBytes(p).catch(() => undefined)));
}

/** Attaches a library file to a job, e.g. as an input for a new job. */
export async function attachToTask(
  organizationId: string,
  taskId: string,
  fileId: string,
  role: "input" | "output" = "input",
): Promise<void> {
  const [owned] = await getDb().query("select 1 from files where id = $1 and organization_id = $2", [fileId, organizationId]);
  if (!owned) throw new Error("That file isn't in this company's library.");
  await getDb().query(
    "insert into task_files (task_id, file_id, role) values ($1, $2, $3) on conflict (task_id, file_id) do nothing",
    [taskId, fileId, role],
  );
}

export async function detachFromTask(taskId: string, fileId: string): Promise<void> {
  await getDb().query("delete from task_files where task_id = $1 and file_id = $2", [taskId, fileId]);
}

/** Finds library files by name, for the Chief of Staff to attach to new jobs. */
export async function findFiles(organizationId: string, names: string[], { viewer }: { viewer?: string } = {}): Promise<{ id: string; name: string }[]> {
  if (names.length === 0) return [];
  return getDb().query<{ id: string; name: string }>(
    `select distinct on (lower(f.name)) f.id, f.name from files f
     where f.organization_id = $1 and lower(f.name) = any($2::text[]) and f.kind = 'deliverable'
       and ($3::uuid is null or ${fileVisibleTo("$3")})
     order by lower(f.name), f.updated_at desc`,
    [organizationId, names.map((n) => n.trim().toLowerCase()), viewer ?? null],
  );
}
