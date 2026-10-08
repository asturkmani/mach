import { buildPageDocument, FRAME_CSP, type FrameTheme } from "@/lib/page-frame";
import { getPage, pageHtml, readPageData } from "@/lib/pages";
import { getSessionContext } from "@/lib/session";

/**
 * A page as the document its frame shows: its HTML, Mach's look and its data,
 * under a policy that sandboxes it and lets it connect nowhere. ?v= shows an
 * older version; ?theme= follows the app's light or dark setting.
 */
export async function GET(request: Request, { params }: RouteContext<"/pages/[slug]/frame">) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Not found.", { status: 404 });
  const { slug } = await params;
  const url = new URL(request.url);
  const page = await getPage(context.organization.id, slug);
  const version = Number(url.searchParams.get("v")) || undefined;
  const html = page && (await pageHtml(context.organization.id, slug, version));
  if (!page || !html) return new Response("Not found.", { status: 404 });

  const asked = url.searchParams.get("theme");
  const theme: FrameTheme = asked === "light" || asked === "dark" ? asked : "system";
  const files = await readPageData(context.organization.id, page);
  const document = buildPageDocument({
    html: html.html,
    title: page.title,
    theme,
    files: files.map((f) => ({ path: f.path, updatedAt: f.updatedAt?.toISOString() ?? null, value: f.value, problem: f.problem })),
  });
  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": FRAME_CSP,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
