import "server-only";

import { createHash } from "node:crypto";

import { get as getBlob, put as putBlob } from "@vercel/blob";

import { getDb } from "@/lib/db";

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
};

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
// Content storage

const blobConnected = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

async function storeContent(
  organizationId: string,
  fileId: string,
  version: number,
  name: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ blobPathname: string | null; content: Buffer | null }> {
  if (!blobConnected()) return { blobPathname: null, content: bytes };
  const blob = await putBlob(`orgs/${organizationId}/files/${fileId}/v${version}/${name}`, bytes, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { blobPathname: blob.pathname, content: null };
}

async function loadContent(row: { blob_pathname: string | null; content: Uint8Array | null }): Promise<Buffer> {
  if (row.content) return Buffer.from(row.content);
  if (!row.blob_pathname) return Buffer.alloc(0);
  const blob = await getBlob(row.blob_pathname, { access: "private" });
  if (!blob) throw new Error(`File content is missing from Blob storage (${row.blob_pathname}).`);
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
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

type FileRow = { id: string; name: string; kind: FileKind; updated_at: Date; role?: "input" | "output" };

export async function listTaskFiles(organizationId: string, taskId: string): Promise<TaskFile[]> {
  const rows = await getDb().query<FileRow>(
    `select f.id, f.name, f.kind, f.updated_at, tf.role from task_files tf
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
  }));
}

export async function listLibrary(organizationId: string, { limit = 200 } = {}): Promise<LibraryFile[]> {
  const rows = await getDb().query<FileRow>(
    "select id, name, kind, updated_at from files where organization_id = $1 order by updated_at desc limit $2",
    [organizationId, limit],
  );
  const versions = await versionsOf(rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, updatedAt: r.updated_at, versions: versions.get(r.id) ?? [] }));
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
  return { name: row.name, kind: row.kind, version: row.version, contentType: row.content_type, bytes: await loadContent(row) };
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
    const [created] = await db.query<{ id: string }>(
      "insert into files (organization_id, name, kind) values ($1, $2, $3) returning id",
      [organizationId, name, input.kind],
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
      "insert into task_files (task_id, file_id, role) values ($1, $2, 'output') on conflict (task_id, file_id) do nothing",
      [input.taskId, fileId],
    );
  }
  if (latest && latest.sha256 === sha256) {
    if (input.note) await db.query("update file_versions set note = $2 where id = $1", [latest.id, input.note]);
    return { fileId, versionId: latest.id, version: latest.version, basedOn: null, unchanged: true };
  }

  const version = (latest?.version ?? 0) + 1;
  const stored = await storeContent(organizationId, fileId, version, name, input.bytes, contentType);
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
export async function findFiles(organizationId: string, names: string[]): Promise<{ id: string; name: string }[]> {
  if (names.length === 0) return [];
  return getDb().query<{ id: string; name: string }>(
    `select distinct on (lower(name)) id, name from files
     where organization_id = $1 and lower(name) = any($2::text[]) and kind = 'deliverable'
     order by lower(name), updated_at desc`,
    [organizationId, names.map((n) => n.trim().toLowerCase())],
  );
}
