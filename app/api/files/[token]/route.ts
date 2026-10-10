import { readFileLinkToken } from "@/lib/file-links";
import { readVersion } from "@/lib/files";

// A file version behind a signed, ten-minute link (lib/file-links.ts), for a
// service that fetches it itself: Twilio, sending a file on WhatsApp.
export async function GET(_: Request, { params }: RouteContext<"/api/files/[token]">) {
  const link = readFileLinkToken((await params).token);
  const file = link ? await readVersion(link.organizationId, link.versionId) : null;
  if (!file) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType === "image/svg+xml" ? "application/octet-stream" : file.contentType,
      "Content-Disposition": `attachment; filename="${file.name.replace(/["\\]/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
