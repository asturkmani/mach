import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { MAX_FILE_BYTES, uploadsPrefix } from "@/lib/files";
import { getSessionContext } from "@/lib/session";

// Signs a browser's upload of a file attached in a task's thread straight to
// Blob, so it doesn't pass through a function. Only signed-in people, and only
// under their company's uploads prefix. The reply then takes it into the
// library (replyAction), which deletes the upload.
export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Sign in first.", { status: 401 });
  const prefix = uploadsPrefix(context.organization.id);
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const name = pathname.slice(prefix.length);
        if (!pathname.startsWith(prefix) || !name || name.includes("/")) throw new Error("That isn't an upload path.");
        return { maximumSizeInBytes: MAX_FILE_BYTES, addRandomSuffix: true };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Upload failed." }, { status: 400 });
  }
}
