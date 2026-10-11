import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { checkPage, describeCheck, readPageStep, refreshPageStep, savePageStep, sharePageStep, type SavedPage } from "@/lib/agents/page-steps";
import type { AgentContext } from "@/lib/agents/prompts";
import type { SandboxUser } from "@/lib/agents/toolkit";
import type { PageAuthor } from "@/lib/pages";

// The tools for pages: views of the company's data, shown as reports in
// Pages. The Worker has them once the building-pages skill is loaded: it
// writes a page's HTML against files on the drive, checks it in its sandbox
// browser, and sets up the quiet job that keeps the data fresh. Each does its
// work in durable steps (lib/agents/page-steps.ts), as a task's run is a workflow.

type SaveOutput = { error: string } | (Omit<Extract<SavedPage, { page: unknown }>, "document"> & { check: string | null });

export function pageTools(context: AgentContext, using: SandboxUser, by: PageAuthor) {
  return {
    save_page: tool({
      description:
        "Create a page (a report on company data, in Pages), or save a new version of one. Only with real data: if it isn't available yet, don't save a page; say what's needed. Load the building-pages skill first. The page is one HTML document that reads what you list in data (drive files, and Mach1's own tasks, people and agents, live) from window.mach.data; it can't fetch anything. It's checked in your sandbox browser after saving, and you get what rendered and any script errors.",
      inputSchema: z.object({
        page: z.string().optional().describe("The slug of the page to change. Leave out to create a page."),
        title: z.string().min(1).max(40).describe("A short name for the tab, e.g. Net worth."),
        description: z.string().max(200).optional().describe("One line on what it shows and where the data comes from."),
        html: z.string().min(1).describe("The whole HTML document."),
        data: z
          .array(z.string())
          .describe("What it reads: drive files (paths under /vercel/drive, e.g. masttro/holdings.json) and Mach1's own data by name (mach:tasks, mach:people, mach:agents)."),
        note: z.string().max(120).optional().describe("What this version changed, e.g. 'Added the entity filter'."),
      }),
      execute: async (input): Promise<SaveOutput> => {
        const saved = await savePageStep(context, by, input);
        if ("error" in saved) return saved;
        const { document, ...rest } = saved;
        let check: string | null = null;
        if (document) {
          const result = await using(() => checkPage(context, document)).catch((error) => {
            console.error("Page check failed", error);
            return null;
          });
          check = result ? describeCheck(result) : "The check couldn't run this time.";
        }
        return { ...rest, check };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value:
          "error" in output
            ? `Not saved: ${output.error}`
            : [
                `${output.created ? "Created" : output.changed ? "Saved" : "No change to"} ${output.page.title} (${output.page.slug}), version ${output.page.version}: ${output.page.url}${context.taskId ? " (give them this link in your report)" : ""}.`,
                `Data: ${output.data.map((d) => `${d.path} (${d.status})`).join(", ") || "none"}.`,
                output.check ?? "",
              ]
                .filter(Boolean)
                .join("\n\n"),
      }),
    }),
    share_page: tool({
      description:
        "Share a page with the whole company (its refresh job too), or make it private again to whoever made it. Only for pages the person the work is for made.",
      inputSchema: z.object({ page: z.string().describe("The page's slug."), withCompany: z.boolean() }),
      execute: ({ page, withCompany }) => sharePageStep(context, by, page, withCompany),
    }),
    read_page: tool({
      description: "Read a page: its current HTML, the drive files it reads and how it's refreshed. Do this before changing a page.",
      inputSchema: z.object({ page: z.string().describe("The page's slug.") }),
      execute: ({ page }) => readPageStep(context, by, page),
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
      execute: ({ page, ...refresh }) => refreshPageStep(context, by, page, refresh),
    }),
  } satisfies ToolSet;
}
