import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { drivePath, MAX_DRIVE_FILE_BYTES, uploadPrefix } from "@/lib/drive";
import { getSessionContext } from "@/lib/session";

// Signs a browser's upload straight to Blob, so big datasets don't pass
// through a function. Only signed-in people, and only under their company's
// drive prefix. The browser then registers the upload (registerDriveUploadAction).
export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Sign in first.", { status: 401 });
  const prefix = uploadPrefix(context.organization.id);
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(prefix) || drivePath(pathname.slice(prefix.length)) !== pathname.slice(prefix.length)) {
          throw new Error("That isn't a drive path.");
        }
        return { maximumSizeInBytes: MAX_DRIVE_FILE_BYTES, addRandomSuffix: true };
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Upload failed." }, { status: 400 });
  }
}
