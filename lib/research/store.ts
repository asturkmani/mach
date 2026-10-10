import "server-only";

import { getDb } from "@/lib/db";
import { parseSource, SourceError, sourceLabel, type ResearchSource, type SourceKind } from "@/lib/research/sources";

// Saved research sources (sources.ts) in the database. People see their own
// and the company's; who may change which is in lib/operations.ts.

type SourceRow = {
  id: string;
  kind: SourceKind;
  handle: string;
  note: string;
  visibility: "company" | "private";
  owner_person_id: string | null;
  created_at: Date;
};

const COLUMNS = "id, kind, handle, note, visibility, owner_person_id, created_at";

/** Enough for anyone's research; more is a list nobody reads. */
export const MAX_SOURCES = 200;

const toSource = (r: SourceRow): ResearchSource => ({
  id: r.id,
  kind: r.kind,
  handle: r.handle,
  note: r.note,
  visibility: r.visibility,
  ownerPersonId: r.owner_person_id,
  createdAt: r.created_at,
});

/** The company's sources and the viewer's own (just the company's with no viewer): theirs first. */
export async function listSources(organizationId: string, { viewer }: { viewer?: string | null } = {}): Promise<ResearchSource[]> {
  const rows = await getDb().query<SourceRow>(
    `select ${COLUMNS} from research_sources
     where organization_id = $1 and (visibility = 'company' or owner_person_id = $2)
     order by (owner_person_id is not distinct from $2) desc, kind, lower(handle)`,
    [organizationId, viewer ?? null],
  );
  // The same source saved privately and by the company shows once, as theirs.
  const seen = new Set<string>();
  return rows.map(toSource).filter((s) => {
    const key = `${s.kind}:${s.handle.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One of the sources the viewer can see, by id or as people give it (@DeItaone, r/investing, ft.com). */
export async function findSource(organizationId: string, viewer: string, ref: string): Promise<ResearchSource | null> {
  const visible = await listSources(organizationId, { viewer });
  const byId = visible.find((s) => s.id === ref.trim());
  if (byId) return byId;
  let parsed: { kind: SourceKind; handle: string } | null = null;
  try {
    parsed = parseSource(ref);
  } catch {
    // A bare name: any kind with that handle, if only one has it.
    const named = visible.filter((s) => s.handle.toLowerCase() === ref.trim().replace(/^[@]/, "").toLowerCase());
    return named.length === 1 ? named[0] : null;
  }
  return visible.find((s) => s.kind === parsed.kind && s.handle.toLowerCase() === parsed.handle.toLowerCase()) ?? null;
}

/**
 * Saves a source for its owner (or updates the note and who sees it, if they
 * saved it already). Throws SourceError for something that isn't a source.
 */
export async function saveSource(
  organizationId: string,
  input: { source: string; kind?: SourceKind; note?: string; visibility?: "company" | "private"; ownerPersonId: string },
): Promise<{ source: ResearchSource; created: boolean }> {
  const { kind, handle } = parseSource(input.source, input.kind);
  const [{ count }] = await getDb().query<{ count: number }>(
    "select count(*)::int as count from research_sources where organization_id = $1",
    [organizationId],
  );
  const [existing] = await getDb().query<SourceRow>(
    `select ${COLUMNS} from research_sources where organization_id = $1 and owner_person_id = $2 and kind = $3 and lower(handle) = lower($4)`,
    [organizationId, input.ownerPersonId, kind, handle],
  );
  if (!existing && count >= MAX_SOURCES) throw new SourceError(`The company already has ${MAX_SOURCES} saved sources. Remove some first.`);
  const [row] = await getDb().query<SourceRow>(
    existing
      ? `update research_sources set note = coalesce($3, note), visibility = coalesce($4, visibility), handle = $5
         where organization_id = $1 and id = $2 returning ${COLUMNS}`
      : `insert into research_sources (organization_id, owner_person_id, note, visibility, handle, kind)
         values ($1, $2, coalesce($3, ''), coalesce($4, 'private'), $5, $6) returning ${COLUMNS}`,
    existing
      ? [organizationId, existing.id, input.note?.trim() ?? null, input.visibility ?? null, handle]
      : [organizationId, input.ownerPersonId, input.note?.trim() ?? null, input.visibility ?? null, handle, kind],
  );
  return { source: toSource(row), created: !existing };
}

export async function updateSource(
  organizationId: string,
  id: string,
  patch: { note?: string; visibility?: "company" | "private" },
): Promise<ResearchSource | null> {
  const [row] = await getDb().query<SourceRow>(
    `update research_sources set note = coalesce($3, note), visibility = coalesce($4, visibility)
     where organization_id = $1 and id = $2 returning ${COLUMNS}`,
    [organizationId, id, patch.note?.trim() ?? null, patch.visibility ?? null],
  );
  return row ? toSource(row) : null;
}

export async function removeSource(organizationId: string, id: string): Promise<void> {
  await getDb().query("delete from research_sources where organization_id = $1 and id = $2", [organizationId, id]);
}

/** One line per source for chat: "@DeItaone (X account, yours): breaking macro". */
export function describeSources(sources: ResearchSource[], viewer: string): string {
  return sources
    .map((s) => `${sourceLabel(s)} (${s.ownerPersonId === viewer ? (s.visibility === "company" ? "yours, shared with the company" : "yours") : "the company's"})${s.note ? `: ${s.note}` : ""}`)
    .join("\n");
}
