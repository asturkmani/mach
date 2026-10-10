import "server-only";

import { z } from "zod";

import { defineAction } from "@/lib/actions/define";
import { appUrl } from "@/lib/app-url";
import { removeSourceAs, saveSourceAs, updateSourceAs } from "@/lib/operations";
import { describeSources, listSources } from "@/lib/research/store";
import { SOURCE_KINDS } from "@/lib/research/sources";

// What the Research screen does: the sources people trust most, which the
// Researcher (and anyone researching for them) looks at first. Who may change
// which is in lib/operations.ts.

const sourceRef = z.string().min(1).describe("The source as saved (@handle, r/name, u/name or a domain), or its id.");

export const researchActions = [
  defineAction({
    name: "source.add",
    description:
      "Save a source as high signal for your research, so it's looked at first and weighed higher: a website, an X account, a subreddit or a Reddit user (a link, @handle, r/name or u/name). Updates the note if it's saved already.",
    input: z.object({
      source: z.string().min(1).describe("e.g. ft.com, @DeItaone, x.com/DeItaone, r/investing, reddit.com/user/someone"),
      kind: z.enum(SOURCE_KINDS).optional().describe("Only needed for a bare name with no @, r/ or u/."),
      note: z.string().max(300).optional().describe("Why it's worth reading, e.g. 'breaking macro headlines'."),
      shareWithCompany: z.boolean().optional().describe("Also use it for everyone's research. Otherwise it's just theirs."),
    }),
    run: ({ actor }, input) => saveSourceAs(actor, input),
  }),
  defineAction({
    name: "source.update",
    description: "Change a saved source's note, or share it for the company's research (or make it just yours again).",
    input: z.object({ source: sourceRef, note: z.string().max(300).optional(), shareWithCompany: z.boolean().optional() }),
    run: ({ actor }, { source, ...patch }) => updateSourceAs(actor, source, patch),
  }),
  defineAction({
    name: "source.remove",
    description: "Stop treating a source as high signal.",
    input: z.object({ source: sourceRef }),
    run: ({ actor }, { source }) => removeSourceAs(actor, source),
  }),
  defineAction({
    name: "source.list",
    description: "List your saved high-signal sources and the company's.",
    input: z.object({}),
    run: async ({ actor }) => {
      const sources = await listSources(actor.organizationId, { viewer: actor.personId });
      if (!sources.length) return `No saved sources yet. Add one here or at ${appUrl("/research")}.`;
      return `${describeSources(sources, actor.personId)}\n${appUrl("/research")}`;
    },
  }),
];
