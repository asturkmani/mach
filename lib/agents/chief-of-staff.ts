import "server-only";

import {
  gateway,
  ToolLoopAgent,
  tool,
  type InferAgentUIMessage,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";

import { completeOnboarding, renameOrganization, type Organization } from "@/lib/orgs";
import { removePersonByName, savePerson, syncPeopleSection } from "@/lib/people";
import { onboardingChecklist, PEOPLE_SECTION, SECTIONS, setCompanyName, setSection } from "@/lib/profile/markdown";
import { updateProfile } from "@/lib/profile/store";
import type { SessionUser } from "@/lib/session";

type Context = { organization: Organization; user: SessionUser; profile: string };

function onboardingInstructions({ organization }: Context): string {
  const website = organization.website
    ? `Their website is ${organization.website}. Before your first question, read it with fetch_page (and one or two linked pages such as About or Services if useful), save a draft Overview and anything else it clearly states, then ask them to confirm.`
    : "No website was given. Ask for it once; if they don't have one, ask what the company does and for whom.";

  return `Right now you are onboarding them. The goal is a quick, basic picture of the company in about five minutes, not a complete profile. Everything else gets filled in over time.

Only three things are needed to finish onboarding:
1. What the company does and for whom (Overview). ${website}
2. The team and who reports to whom. Ask for everyone in one go ("Who's on the team? Give me names, roles and who each reports to."). Mention they can also add people on the Team page and invite them from there.
3. The top one to three priorities right now (Goals).

How to run it:
- Ask one question per message and no more than about five questions in total. Keep messages short.
- Propose instead of asking: draft from what you already know and ask "Is that right?".
- Never ask the person to explain a product, tool, company or term you can look up. Use web_search, record what you learn (Glossary or How We Work), and carry on. Example: if they say they use Masttro, look it up and note what it is; don't ask what it is for.
- Don't ask about mission, values, customers, products or glossary unless they bring it up. Record anything they volunteer.
- As soon as the three essentials are captured, call complete_onboarding on its own (after your other saves). If it reports something missing, ask about that in one short question and try again later. Once it succeeds, reply with a three-line summary and tell them they can keep telling you things at any time.`;
}

const AFTER_ONBOARDING = `Onboarding is complete. You are now the company's Chief of Staff: answer questions using the profile, record anything new you learn, and keep the people list and reporting lines up to date. Don't start a new interview; ask at most one short question when something important is missing.`;

export function chiefOfStaffInstructions(context: Context): string {
  const { organization, user, profile } = context;
  const today = new Date().toISOString().slice(0, 10);
  return `You are the Chief of Staff of ${organization.name}, a company that uses Mach, a command center where people and AI agents run the business together.

You are talking to ${user.name} (${user.email}), who is already in the people list. If you learn their role or manager, save it.

${organization.onboardingCompletedAt ? AFTER_ONBOARDING : onboardingInstructions(context)}

Recording facts:
- The company profile below is a markdown document and your memory of the company. Record facts as soon as you learn them; don't ask permission to save.
- Write in the company's own words, concise and factual. Never invent facts.
- Use save_person / remove_person for people. Never write the "${PEOPLE_SECTION}" section with update_section; it is generated from the people list.
- Use update_section for every other section, passing the complete new body (markdown, no "## " heading). It replaces what was there, so keep anything that should stay.
- Use set_company_name only if they correct the company's name.

Sections: ${SECTIONS.join(", ")}.

Today's date: ${today}.

<company_profile>
${profile}
</company_profile>`;
}

const sectionNames = SECTIONS.filter((s) => s !== PEOPLE_SECTION) as [string, ...string[]];

// Tools return the latest profile for the live preview, but the model only sees
// a short confirmation: it gets the current profile in its instructions on every
// request, so repeating it in each tool result would just bloat the context.
const confirm = (value: string) => () => ({ type: "text" as const, value });

function profileTools({ organization }: Context) {
  const orgId = organization.id;
  return {
    set_company_name: tool({
      description: "Correct the company's name.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        await renameOrganization(orgId, name);
        return { profile: await updateProfile(orgId, (md) => setCompanyName(md, name)) };
      },
      toModelOutput: confirm("Saved."),
    }),
    update_section: tool({
      description:
        "Replace the body of one profile section with new markdown. Pass the full section body, not a diff. Not for the people section.",
      inputSchema: z.object({
        section: z.enum(sectionNames),
        content: z.string().describe("Full markdown body for the section, without the '## ' heading."),
      }),
      execute: async ({ section, content }) => ({
        profile: await updateProfile(orgId, (md) => setSection(md, section, content)),
      }),
      toModelOutput: confirm("Saved."),
    }),
    save_person: tool({
      description:
        "Add a person to the organisation or update their details. Only the fields you pass are changed. reportsTo is the exact name of their manager (an unknown manager is added too); use an empty string for someone who reports to no one.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Full name, used as the person's identifier."),
        role: z.string().optional().describe("Job title or role."),
        reportsTo: z.string().optional().describe("Exact name of the person they report to, or empty."),
        responsibilities: z.string().optional().describe("What they own, in a short phrase."),
        email: z.string().optional(),
        phone: z.string().optional().describe("Phone or WhatsApp number."),
      }),
      execute: async ({ reportsTo, ...person }) => {
        await savePerson(orgId, { ...person, managerName: reportsTo });
        return { profile: await syncPeopleSection(orgId) };
      },
      toModelOutput: confirm("Saved."),
    }),
    remove_person: tool({
      description: "Remove a person from the organisation. Anyone who reported to them is left without a manager.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const removed = await removePersonByName(orgId, name);
        return { removed, profile: await syncPeopleSection(orgId) };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: output.removed ? "Removed." : "No one by that name was in the people list.",
      }),
    }),
    complete_onboarding: tool({
      description:
        "Mark onboarding as finished. Only succeeds once the company overview, the team with reporting lines (everyone but the person at the top has a manager) and top priorities are captured; otherwise it lists what's missing.",
      inputSchema: z.object({}),
      execute: async () => {
        // Queued behind any profile updates still in flight from this step.
        const profile = await updateProfile(orgId, (md) => md);
        const missing = onboardingChecklist(profile)
          .filter((item) => !item.done)
          .map((item) => (item.detail ? `${item.label} (${item.detail})` : item.label));
        if (missing.length > 0) return { onboardingComplete: false, missing, profile };
        await completeOnboarding(orgId);
        return { onboardingComplete: true, missing, profile };
      },
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: output.onboardingComplete
          ? "Onboarding is marked complete."
          : `Not complete yet. Missing: ${output.missing.join("; ")}. If you saved this in the same step, call complete_onboarding again. Otherwise ask one short question about it; if someone has no manager, ask where they fit (for example whether the person you're talking to is one of the people already listed).`,
      }),
    }),
  };
}

// Run by AI Gateway and billed to its credits: a few dollars per thousand calls.
const researchTools = {
  web_search: gateway.tools.parallelSearch({ mode: "agentic", maxResults: 5 }),
  fetch_page: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true, proxies: false }),
} satisfies ToolSet;

export function createChiefOfStaff(
  context: Context,
  options: { model?: LanguageModel; research?: boolean } = {},
) {
  const model = options.model ?? process.env.CHIEF_OF_STAFF_MODEL;
  if (!model) {
    throw new Error("Set CHIEF_OF_STAFF_MODEL to an AI Gateway model id (see README).");
  }
  return new ToolLoopAgent({
    model,
    instructions: chiefOfStaffInstructions(context),
    tools: { ...profileTools(context), ...(options.research === false ? {} : researchTools) },
  });
}

export type ChiefOfStaffMessage = InferAgentUIMessage<ReturnType<typeof createChiefOfStaff>>;
