import { readDriveFile } from "@/lib/drive";
import { getSessionContext } from "@/lib/session";

/** Downloads a file from the company drive: /drive?path=option-flow/2026-10-07.csv */
export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Not found.", { status: 404 });
  const path = new URL(request.url).searchParams.get("path") ?? "";
  let file;
  try {
    file = await readDriveFile(context.organization.id, path);
  } catch {
    return new Response("Not found.", { status: 404 });
  }
  if (!file) return new Response("Not found.", { status: 404 });
  const name = file.path.split("/").pop()!;
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType === "image/svg+xml" ? "application/octet-stream" : file.contentType,
      "Content-Disposition": `attachment; filename="${name.replace(/["\\]/g, "")}"`,
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
