import "server-only";

import { getAgent } from "@/lib/agents/store";
import { getPage } from "@/lib/pages";
import { getTaskByNumber } from "@/lib/tasks";

// What someone is looking at in Mach1 while they talk to the Chief of Staff,
// so "change this" or "why is this stuck?" means something. The browser only
// sends its path; what's there is looked up here, for this company only.

const SETTINGS: Record<string, string> = {
  "": "Settings",
  account: "their account settings",
  channels: "Settings › Channels (WhatsApp and email)",
  integrations: "Settings › Integrations",
};

/** A short description of the screen at this path, or null when it's not one worth naming. */
export async function describeViewing(organizationId: string, path: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(path, "https://mach.local");
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [section, id, ...rest] = parts;

  if (!section) return "Home: what needs them, then the company's work as a board or list";
  if (section === "tasks" && /^\d+$/.test(id ?? "")) {
    const task = await getTaskByNumber(organizationId, Number(id));
    if (!task) return null;
    const people = task.members.filter((m) => m.type === "person").map((m) => m.name);
    const agents = task.members.filter((m) => m.type === "agent").map((m) => m.name);
    return [
      `task #${task.number} "${task.title}" (${task.status.replace("_", " ")}, ${task.priority} priority`,
      people.length ? `; people: ${people.join(", ")}` : "",
      agents.length ? `; agents: ${agents.join(", ")}` : "",
      `)${task.summary ? `. Its summary: ${task.summary}` : ""}`,
    ].join("");
  }
  if (section === "pages") {
    if (!id) return "Pages, with no page open";
    const page = await getPage(organizationId, id);
    if (!page) return null;
    const version = Number(url.searchParams.get("v"));
    return [
      `the "${page.title}" page (slug ${page.slug}, version ${page.version}`,
      version && version !== page.version ? `, though they're viewing its old version ${version}` : "",
      `; reads ${page.data.join(", ") || "no data"}`,
      page.taskNumber ? `; refreshed by #${page.taskNumber}` : "",
      `). Use read_page before changing it`,
    ].join("");
  }
  if (section === "agents" && id) {
    const agent = await getAgent(organizationId, id).catch(() => null);
    return agent ? `the agent ${agent.name}'s page${agent.role ? ` (${agent.role})` : ""}` : null;
  }
  if (section === "team") return "the Team page (people and agents)";
  if (section === "files") return "Files: the company's file library and drive";
  if (section === "company") return "the company profile";
  if (section === "settings") return SETTINGS[id ?? ""] ?? `Settings › ${[id, ...rest].join(" › ")}`;
  return null;
}
