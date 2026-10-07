import { getSessionContext } from "@/lib/session";
import { getTaskByNumber, listOutputs } from "@/lib/tasks";

const TYPES: Record<string, string> = {
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
};

/** Downloads a file an agent saved on a task. */
export async function GET(_request: Request, { params }: RouteContext<"/tasks/[number]/files/[fileId]">) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Not found.", { status: 404 });
  const { number, fileId } = await params;
  const task = await getTaskByNumber(context.organization.id, Number(number));
  const file = task && (await listOutputs(task.id)).find((o) => o.id === fileId);
  if (!file) return new Response("Not found.", { status: 404 });

  const extension = file.filename.split(".").pop()?.toLowerCase() ?? "txt";
  return new Response(file.content, {
    headers: {
      "Content-Type": `${TYPES[extension] ?? "text/plain"}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
    },
  });
}
