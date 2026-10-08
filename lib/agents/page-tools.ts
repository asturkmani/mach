import "server-only";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { checkPage, describeCheck } from "@/lib/agents/page-steps";
import type { AgentContext } from "@/lib/agents/prompts";
import type { SandboxUser } from "@/lib/agents/toolkit";
import { appUrl } from "@/lib/app-url";
import { buildPageDocument } from "@/lib/page-frame";
import { drivePath } from "@/lib/drive";
import { isMachSource } from "@/lib/mach-sources";
import { getPage, pageDataStatus, pageHtml, PageError, readPageData, savePage, setPageRefresh, type PageAuthor } from "@/lib/pages";
import { getSchedule } from "@/lib/schedules";

// The Chief of Staff's tools for pages: views of the company's data, shown as
// reports in Pages. It writes a page's HTML against files on the drive, checks it
// in its sandbox browser, and sets up the quiet job that keeps the data fresh.

const ago = (date: Date | null) => {
  if (!date) return "not on the drive yet";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  return minutes < 2 ? "updated just now" : minutes < 120 ? `updated ${minutes} min ago` : `updated ${Math.round(minutes / 60)} h ago`;
};

export function pageTools(context: AgentContext, using: SandboxUser, by: PageAuthor) {
  const orgId = context.organizationId;
  return {
    save_page: tool({
      description:
        "Create a page (a report on company data, in Pages), or save a new version of one. Only with real data: if it isn't available yet, don't save a page; say what's needed. Load the building-pages skill first. The page is one HTML document that reads what you list in data (drive files, and Mach's own tasks, people and agents, live) from window.mach.data; it can't fetch anything. It's checked in your sandbox browser after saving, and you get what rendered and any script errors.",
      inputSchema: z.object({
        page: z.string().optional().describe("The slug of the page to change. Leave out to create a page."),
        title: z.string().min(1).max(40).describe("A short name for the tab, e.g. Net worth."),
        description: z.string().max(200).optional().describe("One line on what it shows and where the data comes from."),
        html: z.string().min(1).describe("The whole HTML document."),
        data: z
          .array(z.string())
          .describe("What it reads: drive files (paths under /vercel/drive, e.g. masttro/holdings.json) and Mach's own data by name (mach:tasks, mach:people, mach:agents)."),
        note: z.string().max(120).optional().describe("What this version changed, e.g. 'Added the entity filter'."),
      }),
      execute: async (input) => {
        try {
          // A page is a report on real data: refuse one whose data doesn't exist yet rather than save a placeholder.
          const data = input.data.map((path) => (isMachSource(path.trim()) ? path.trim() : drivePath(path)));
          const status = await pageDataStatus(orgId, { data });
          if (status.length === 0 || status.every((f) => !f.live && !f.updatedAt)) {
            return {
              error: `none of its data exists yet${data.length ? ` (${data.join(", ")} ${data.length === 1 ? "isn't" : "aren't"} on the drive)` : ""}. Get the data first (connect the system, run the script that writes the file), or tell them what's needed; don't build a placeholder page.`,
            };
          }
          const { page, created, changed } = await savePage(orgId, {
            slug: input.page,
            title: input.title,
            description: input.description,
            html: input.html,
            data: input.data,
            note: input.note ?? (input.page ? "" : "First version"),
            by,
          });
          const files = await readPageData(orgId, page);
          let check: string | null = null;
          if (changed) {
            const html = (await pageHtml(orgId, page.slug))!.html;
            const document = buildPageDocument({
              html,
              title: page.title,
              theme: "light",
              files: files.map((f) => ({ path: f.path, updatedAt: f.updatedAt?.toISOString() ?? null, value: f.value, problem: f.problem })),
            });
            const result = await using(() => checkPage(context, document)).catch((error) => {
              console.error("Page check failed", error);
              return null;
            });
            check = result ? describeCheck(result) : "The check couldn't run this time.";
          }
          return {
            page: { slug: page.slug, title: page.title, version: page.version, url: appUrl(`/pages/${page.slug}`), pinned: page.pinned },
            created,
            changed,
            data: files.map((f) => ({ path: f.path, status: f.problem ?? ago(f.updatedAt) })),
            check,
          };
        } catch (error) {
          if (error instanceof PageError) return { error: error.message };
          if (error instanceof Error && /drive|path|name/i.test(error.message)) return { error: error.message };
          throw error;
        }
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not saved: ${output.error}`
            : [
                `${output.created ? "Created" : output.changed ? "Saved" : "No change to"} ${output.page.title} (${output.page.slug}), version ${output.page.version}. They see a card that opens it.`,
                `Data: ${output.data.map((d) => `${d.path} (${d.status})`).join(", ") || "none"}.`,
                output.check ?? "",
              ]
                .filter(Boolean)
                .join("\n\n"),
      }),
    }),
    read_page: tool({
      description: "Read a page: its current HTML, the drive files it reads and how it's refreshed. Do this before changing a page.",
      inputSchema: z.object({ page: z.string().describe("The page's slug.") }),
      execute: async ({ page: slug }): Promise<string> => {
        const page = await getPage(orgId, slug);
        const html = page && (await pageHtml(orgId, slug));
        if (!page || !html) return `There's no page called ${slug}.`;
        const schedule = page.taskId ? await getSchedule(page.taskId) : null;
        const files = await readPageData(orgId, { data: page.data });
        return [
          `${page.title}, version ${html.version}. ${page.description}`,
          `Data: ${files.map((f) => `${f.path} (${f.problem ?? ago(f.updatedAt)})`).join(", ") || "none"}`,
          `Refreshed by: ${page.taskNumber ? `#${page.taskNumber}${schedule ? `, ${schedule.description}` : ""}` : "nothing yet"}`,
          "",
          html.html,
        ].join("\n");
      },
    }),
    refresh_page: tool({
      description:
        "Keep a page's data fresh: a quiet recurring job runs the command that writes its drive files (a script you saved on the drive), without a model. It runs once now; runs that work don't reach anyone, and if one fails an agent fixes it. Reuse it to change the command or the schedule.",
      inputSchema: z.object({
        page: z.string().describe("The page's slug."),
        command: z.string().describe("e.g. python3 /vercel/drive/pages/net-worth/refresh.py"),
        cron: z.string().describe("Five-field cron in the timezone, e.g. '0 7 * * 1-5' for weekdays at 07:00."),
        timezone: z.string().describe("IANA timezone, e.g. Europe/London."),
      }),
      execute: async ({ page, ...refresh }): Promise<string> => {
        try {
          const result = await setPageRefresh(orgId, page, refresh, { name: by.name, personId: by.personId });
          return `Job #${result.taskNumber} refreshes it ${result.schedule.description}, and is running once now. Runs that work stay quiet; a failure goes to an agent and then to them.`;
        } catch (error) {
          if (error instanceof PageError) return `Not set up: ${error.message}`;
          throw error;
        }
      },
    }),
  } satisfies ToolSet;
}
