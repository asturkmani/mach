import { readVersion } from "@/lib/files";
import { getSessionContext } from "@/lib/session";

/** Downloads one version of a library file (or shows it inline with ?inline=1, for images). */
export async function GET(request: Request, { params }: RouteContext<"/files/[versionId]">) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Not found.", { status: 404 });
  const { versionId } = await params;
  const file = await readVersion(context.organization.id, versionId);
  if (!file) return new Response("Not found.", { status: 404 });

  const inline = new URL(request.url).searchParams.get("inline") === "1" && file.contentType.startsWith("image/");
  const name = file.version > 1 ? file.name.replace(/(\.[^.]+)?$/, ` v${file.version}$1`) : file.name;
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType === "image/svg+xml" ? "application/octet-stream" : file.contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/["\\]/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
