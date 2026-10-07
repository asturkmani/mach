import "server-only";

import { createHash } from "node:crypto";

import { getDb } from "@/lib/db";
import { contentTypeFor } from "@/lib/files";
import { loadBytes, removeBytes, storeBytes } from "@/lib/storage";

// The company data drive: shared datasets that every job's sandbox sees at
// /vercel/drive (an option-flow history, a price database, exports people drop
// in). Unlike the file library it keeps no versions: each path holds its
// latest content, in Vercel Blob when a store is connected. Sandboxes pull
// what changed when a run starts and push what they write after each command.

export const DRIVE_DIR = "/vercel/drive";

/** Larger files stay in the sandbox that made them. */
export const MAX_DRIVE_FILE_BYTES = 100 * 1024 * 1024;

export type DriveFile = {
  path: string;
  size: number;
  contentType: string;
  sha256: string;
  updatedAt: Date;
  taskNumber: number | null;
  agentName: string | null;
  personName: string | null;
};

const SEGMENT = /^[\w@+=,()-][\w .@+=,()-]{0,119}$/;

/**
 * A drive path relative to the drive's root, e.g. "option-flow/2026-10-07.csv".
 * Accepts "/vercel/drive/…" too. Refuses "..", hidden files and odd characters.
 */
export function drivePath(input: string): string {
  const parts = input
    .trim()
    .replace(/^\/vercel\/drive(\/|$)/, "")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.length === 0) throw new Error("Give a file path inside the drive.");
  if (parts.length > 10) throw new Error("Drive paths can be at most 10 folders deep.");
  for (const part of parts) {
    if (part === "..") throw new Error("Paths must stay inside the drive.");
    if (!SEGMENT.test(part) || part.endsWith(" ")) {
      throw new Error(`"${part}" isn't a usable name: use letters, numbers, spaces and - _ . ( ), and don't start with a dot.`);
    }
  }
  return parts.join("/");
}

type DriveRow = {
  path: string;
  size: number;
  content_type: string;
  sha256: string;
  updated_at: Date;
  task_number: number | null;
  agent_name: string | null;
  person_name: string | null;
};

const toFile = (r: DriveRow): DriveFile => ({
  path: r.path,
  size: r.size,
  contentType: r.content_type,
  sha256: r.sha256,
  updatedAt: r.updated_at,
  taskNumber: r.task_number,
  agentName: r.agent_name,
  personName: r.person_name,
});

/** The drive's files, newest first. */
export async function listDrive(organizationId: string, { limit = 1000 } = {}): Promise<DriveFile[]> {
  const rows = await getDb().query<DriveRow>(
    `select d.path, d.size, d.content_type, d.sha256, d.updated_at, t.number as task_number,
            a.name as agent_name, p.name as person_name
     from drive_files d
     left join tasks t on t.id = d.task_id
     left join agents a on a.id = d.agent_id
     left join people p on p.id = d.person_id
     where d.organization_id = $1 order by d.updated_at desc, d.path limit $2`,
    [organizationId, limit],
  );
  return rows.map(toFile);
}

export async function driveStats(organizationId: string): Promise<{ count: number; bytes: number }> {
  const [row] = await getDb().query<{ count: number; bytes: number }>(
    "select count(*)::int as count, coalesce(sum(size), 0)::float8 as bytes from drive_files where organization_id = $1",
    [organizationId],
  );
  return row;
}

export async function readDriveFile(
  organizationId: string,
  path: string,
): Promise<{ path: string; contentType: string; bytes: Buffer } | null> {
  const [row] = await getDb().query<{ path: string; content_type: string; blob_pathname: string | null; content: Uint8Array | null }>(
    "select path, content_type, blob_pathname, content from drive_files where organization_id = $1 and path = $2",
    [organizationId, drivePath(path)],
  );
  if (!row) return null;
  return { path: row.path, contentType: row.content_type, bytes: await loadBytes(row) };
}

/** Saves a file to the drive, replacing what was at that path. Unchanged content is left alone. */
export async function writeDriveFile(
  organizationId: string,
  input: { path: string; bytes: Buffer; taskId?: string; agentId?: string; personId?: string },
): Promise<{ path: string; changed: boolean; sha256: string }> {
  const path = drivePath(input.path);
  if (input.bytes.length > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`${path} is larger than ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const db = getDb();
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const [existing] = await db.query<{ sha256: string; blob_pathname: string | null }>(
    "select sha256, blob_pathname from drive_files where organization_id = $1 and path = $2",
    [organizationId, path],
  );
  if (existing?.sha256 === sha256) return { path, changed: false, sha256 };

  const contentType = contentTypeFor(path);
  const stored = await storeBytes(`orgs/${organizationId}/drive/${path}`, input.bytes, contentType, { unique: true });
  await db.query(
    `insert into drive_files (organization_id, path, content_type, size, sha256, blob_pathname, content, task_id, agent_id, person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (organization_id, path) do update set
       content_type = excluded.content_type, size = excluded.size, sha256 = excluded.sha256,
       blob_pathname = excluded.blob_pathname, content = excluded.content, task_id = excluded.task_id,
       agent_id = excluded.agent_id, person_id = excluded.person_id, updated_at = now()`,
    [
      organizationId,
      path,
      contentType,
      input.bytes.length,
      sha256,
      stored.blobPathname,
      stored.content,
      input.taskId ?? null,
      input.agentId ?? null,
      input.personId ?? null,
    ],
  );
  if (existing?.blob_pathname && existing.blob_pathname !== stored.blobPathname) await removeBytes(existing.blob_pathname);
  return { path, changed: true, sha256 };
}

/** Deletes a file, or a whole folder when the path ends with "/". */
export async function deleteDriveFile(organizationId: string, path: string): Promise<number> {
  const folder = path.trim().endsWith("/");
  const clean = drivePath(path);
  const rows = await getDb().query<{ blob_pathname: string | null }>(
    `delete from drive_files where organization_id = $1 and (path = $2 or ($3 and path like $4 escape '\\'))
     returning blob_pathname`,
    [organizationId, clean, folder, `${clean.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`],
  );
  for (const row of rows) await removeBytes(row.blob_pathname);
  return rows.length;
}

/** Where people's uploads for this company go in Blob; the upload route only signs paths under it. */
export const uploadPrefix = (organizationId: string) => `orgs/${organizationId}/drive/`;

/**
 * Records a file a person uploaded straight to Blob (from the browser) at a
 * drive path. Its content is checked and hashed here, so it syncs like any other.
 */
export async function registerDriveUpload(
  organizationId: string,
  input: { path: string; blobPathname: string; personId?: string },
): Promise<{ path: string; changed: boolean }> {
  const path = drivePath(input.path);
  if (!input.blobPathname.startsWith(uploadPrefix(organizationId))) throw new Error("That upload isn't this company's.");
  const [taken] = await getDb().query("select 1 from drive_files where blob_pathname = $1", [input.blobPathname]);
  if (taken) throw new Error("That upload is already on the drive.");
  const bytes = await loadBytes({ blob_pathname: input.blobPathname, content: null });
  const discard = () => removeBytes(input.blobPathname);
  if (bytes.length > MAX_DRIVE_FILE_BYTES) {
    await discard();
    throw new Error(`${path} is larger than ${MAX_DRIVE_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const db = getDb();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const [existing] = await db.query<{ sha256: string; blob_pathname: string | null }>(
    "select sha256, blob_pathname from drive_files where organization_id = $1 and path = $2",
    [organizationId, path],
  );
  if (existing?.sha256 === sha256) {
    await discard();
    return { path, changed: false };
  }
  await db.query(
    `insert into drive_files (organization_id, path, content_type, size, sha256, blob_pathname, person_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, path) do update set
       content_type = excluded.content_type, size = excluded.size, sha256 = excluded.sha256,
       blob_pathname = excluded.blob_pathname, content = null, task_id = null, agent_id = null,
       person_id = excluded.person_id, updated_at = now()`,
    [organizationId, path, contentTypeFor(path), bytes.length, sha256, input.blobPathname, input.personId ?? null],
  );
  if (existing?.blob_pathname && existing.blob_pathname !== input.blobPathname) await removeBytes(existing.blob_pathname);
  return { path, changed: true };
}
