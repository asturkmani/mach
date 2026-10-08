import "server-only";

import ExcelJS from "exceljs";

import { parseCsv } from "@/lib/csv";
import { getDb } from "@/lib/db";
import { readVersion } from "@/lib/files";

// Read-only previews of job files for the task page: spreadsheet sheets as
// tables, CSVs as tables, text and markdown as text, images inline.

export type SheetPreview = { name: string; rows: string[][]; moreRows: number; moreColumns: number };

export type Preview =
  | { type: "sheets"; sheets: SheetPreview[] }
  | { type: "table"; rows: string[][]; moreRows: number }
  | { type: "markdown"; text: string }
  | { type: "text"; text: string }
  | { type: "image" }
  | null;

const MAX_ROWS = 60;
const MAX_COLUMNS = 14;
const MAX_SHEETS = 8;

function formatNumber(value: number, numFmt: string | undefined): string {
  if (numFmt?.includes("%")) {
    const decimals = (numFmt.split(".")[1]?.match(/0/g) ?? []).length;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  const decimals = numFmt?.includes(".") ? (numFmt.split(".")[1].match(/0/g) ?? []).length : Math.abs(value) >= 100 ? 1 : 3;
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** What a cell shows: a formula's stored result, a formatted number, a date or text. */
export function displayCell(cell: Pick<ExcelJS.Cell, "value" | "numFmt">): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatNumber(value, cell.numFmt);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) {
      const result = (value as { result?: unknown }).result;
      if (result === undefined || result === null) return `=${(value as { formula?: string }).formula ?? "…"}`;
      if (typeof result === "object" && result && "error" in result) return String((result as { error: string }).error);
      return displayCell({ value: result as ExcelJS.CellValue, numFmt: cell.numFmt });
    }
    if ("richText" in value) return value.richText.map((t) => t.text).join("");
    if ("text" in value) return String((value as { text: unknown }).text);
    if ("error" in value) return String((value as { error: string }).error);
  }
  return String(value);
}

export async function spreadsheetPreview(bytes: Buffer): Promise<Preview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheets = workbook.worksheets.slice(0, MAX_SHEETS).map((sheet) => {
    const rowCount = sheet.actualRowCount ? sheet.rowCount : 0;
    const columnCount = sheet.columnCount;
    const rows: string[][] = [];
    for (let r = 1; r <= Math.min(rowCount, MAX_ROWS); r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(columnCount, MAX_COLUMNS); c++) cells.push(displayCell(row.getCell(c)));
      rows.push(cells);
    }
    // Drop trailing empty rows so short sheets stay short.
    while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
    return {
      name: sheet.name,
      rows,
      moreRows: Math.max(0, rowCount - MAX_ROWS),
      moreColumns: Math.max(0, columnCount - MAX_COLUMNS),
    };
  });
  return { type: "sheets", sheets };
}

export async function previewFor(name: string, contentType: string, bytes: Buffer): Promise<Preview> {
  const extension = name.split(".").pop()?.toLowerCase();
  try {
    if (extension === "xlsx") return await spreadsheetPreview(bytes);
    if (contentType.startsWith("image/")) return { type: "image" };
    if (extension === "csv") {
      const rows = parseCsv(bytes.toString("utf8"));
      return { type: "table", rows: rows.slice(0, MAX_ROWS + 1), moreRows: Math.max(0, rows.length - MAX_ROWS - 1) };
    }
    if (extension === "md") return { type: "markdown", text: bytes.toString("utf8").slice(0, 100_000) };
    if (contentType.startsWith("text/") || contentType === "application/json") {
      return { type: "text", text: bytes.toString("utf8").slice(0, 100_000) };
    }
  } catch (error) {
    console.error(`Couldn't preview ${name}`, error);
  }
  return null;
}

/**
 * A version's preview, built from its content the first time and stored, so
 * opening a big workbook again is instant. Code is previewed as text.
 */
export async function versionPreview(organizationId: string, versionId: string): Promise<Preview> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return null;
  const [stored] = await getDb().query<{ preview: Preview | null; has_preview: boolean }>(
    `select v.preview, v.preview is not null as has_preview from file_versions v join files f on f.id = v.file_id
     where v.id = $1 and f.organization_id = $2`,
    [versionId, organizationId],
  );
  if (!stored) return null;
  if (stored.has_preview) return stored.preview;

  const file = await readVersion(organizationId, versionId);
  if (!file) return null;
  const preview: Preview =
    file.kind === "code" ? { type: "text", text: file.bytes.toString("utf8").slice(0, 200_000) } : await previewFor(file.name, file.contentType, file.bytes);
  // JSON null marks "no preview possible", so it isn't recomputed on every open.
  await getDb().query("update file_versions set preview = $2::jsonb where id = $1", [versionId, JSON.stringify(preview)]);
  return preview;
}
