import { versionPreview } from "@/lib/previews";
import { getSessionContext } from "@/lib/session";

/** A file version's read-only preview, as JSON, for the task page. */
export async function GET(_request: Request, { params }: RouteContext<"/files/[versionId]/preview">) {
  const context = await getSessionContext();
  if (!context.organization) return Response.json(null, { status: 404 });
  const { versionId } = await params;
  return Response.json(await versionPreview(context.organization.id, versionId), {
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}
