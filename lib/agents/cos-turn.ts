import "server-only";

import { createAgentUIStream, createIdGenerator, type FileUIPart, type UIMessage } from "ai";

import { createChiefOfStaff, workspaceOf, type Channel } from "@/lib/agents/chief-of-staff";
import { forModel, restoreOriginals } from "@/lib/agents/chat-attachments";
import { prepareHistory } from "@/lib/agents/history";
import { describeViewing } from "@/lib/agents/viewing";
import { closeSandbox } from "@/lib/agents/sandbox-steps";
import { listAgents } from "@/lib/agents/store";
import type { SandboxSession } from "@/lib/agents/toolkit";
import { catchUpSummary, conversationWindow, getPersonalMemory, saveConversation } from "@/lib/agents/conversation";
import { listAiKeys } from "@/lib/ai/keys";
import { getAssistantHours } from "@/lib/assistant/store";
import { endReply, getOrCreateChat, takeTurn, type Chat } from "@/lib/chats";
import { getGitHubConnection } from "@/lib/github";
import { listLibrary } from "@/lib/files";
import { companySkillsFor } from "@/lib/company-skills";
import { pendingProposals } from "@/lib/learning/proposals";
import { listIntegrations } from "@/lib/integrations";
import { memberRoles } from "@/lib/members";
import { listPages } from "@/lib/pages";
import { listPeople } from "@/lib/people";
import type { Organization } from "@/lib/orgs";
import type { Person } from "@/lib/people";
import { loadProfile } from "@/lib/profile/store";
import type { SessionUser } from "@/lib/session";
import { listTasks } from "@/lib/tasks";
import { listScheduledJobs } from "@/lib/work-overview";
import type { LanguageModel } from "ai";

// One Chief of Staff, reached from the app's chat panel, WhatsApp or email.
// Each person has one conversation with it per company, whichever way they
// write: a WhatsApp message lands in the same history as the panel.

export type ChiefOfStaffContext = { organization: Organization; user: SessionUser; person: Person };

export const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });

/** The Chief of Staff for this person and company, with what it reads loaded, and its sandbox session. */
export async function loadChiefOfStaff(
  context: ChiefOfStaffContext,
  options: {
    channel?: Channel;
    model?: LanguageModel;
    research?: boolean;
    /** The path of the screen they're on in the app, if the message came from the chat panel. */
    viewing?: string;
    /** A summary of the conversation before the messages the model is shown in full. */
    earlier?: string;
  } = {},
) {
  const organizationId = context.organization.id;
  const [profile, agents, tasks, jobs, files, integrations, pages, github, memory, hours, team, aiKeys, skills, proposals] = await Promise.all([
    loadProfile(organizationId),
    listAgents(organizationId),
    listTasks(organizationId, { closedLimit: 0, viewer: context.person?.id }),
    listScheduledJobs(organizationId, { viewer: context.person?.id }),
    listLibrary(organizationId, { limit: 30, viewer: context.person?.id }),
    listIntegrations(organizationId, { personId: context.person?.id }),
    listPages(organizationId, { viewer: context.person?.id }),
    context.person ? getGitHubConnection(organizationId, context.person.id) : null,
    context.person ? getPersonalMemory(organizationId, context.person.id) : "",
    context.person ? getAssistantHours(organizationId, context.person.id) : null,
    teamStatus(organizationId),
    listAiKeys(organizationId).catch(() => []),
    companySkillsFor(organizationId, context.person?.id),
    context.person ? pendingProposals(organizationId, context.person.id) : [],
  ]);
  const viewing = options.viewing ? await describeViewing(organizationId, options.viewing, context.person?.id).catch(() => null) : null;
  const sandbox: SandboxSession = {};
  const agent = createChiefOfStaff(
    {
      ...context,
      profile,
      agents,
      openTasks: tasks,
      jobs,
      files,
      integrations,
      pages,
      skills,
      proposals,
      channel: options.channel,
      viewing,
      github,
      memory,
      hours,
      isAdmin: team.admins.has(context.user.id),
      team: team.people,
      aiKeys: aiKeys.map((k) => k.provider),
      earlier: options.earlier,
    },
    { sandbox, model: options.model, research: options.research },
  );
  return {
    agent,
    /** Ends the turn: stops its workspace sandbox if it used one (unless a sign-in waits for a code). */
    close: async () => {
      if (!sandbox.used) return;
      await closeSandbox(workspaceOf(context)).catch((error) => console.error("Couldn't close the Chief of Staff's sandbox", error));
    },
  };
}

/** Who's on the team, who has joined and who's an admin (roles live in WorkOS; without it, nobody is an admin). */
async function teamStatus(organizationId: string) {
  const [people, roles] = await Promise.all([
    listPeople(organizationId),
    memberRoles(organizationId).catch((error) => {
      console.error("Couldn't read the company's roles", (error as Error).message);
      return new Map<string, { role: string }>();
    }),
  ]);
  const admins = new Set([...roles].filter(([, m]) => m.role === "admin").map(([userId]) => userId));
  return {
    admins,
    people: people.map((p) => ({ name: p.name, status: p.status, admin: Boolean(p.workosUserId && admins.has(p.workosUserId)) })),
  };
}

/** The text of the Chief of Staff's reply in a turn: its last message's words. */
export function replyText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return (last?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
}

/** After a reply has gone out: brings the conversation's summary up to date if it's behind. */
export async function catchUpConversation(context: ChiefOfStaffContext): Promise<void> {
  const { id } = await getOrCreateChat<UIMessage>(context.organization.id, context.user.id);
  await catchUpSummary(id).catch((error) => console.error("Couldn't bring the conversation summary up to date", error));
}

/**
 * A whole Chief of Staff turn for a message that came by WhatsApp or email:
 * it joins the person's conversation, runs to the end, and the reply's text
 * comes back to send the same way.
 */
export async function chiefOfStaffTurn(
  context: ChiefOfStaffContext,
  text: string,
  channel: Channel,
  options: TurnOptions = {},
): Promise<string> {
  const { id } = await getOrCreateChat<UIMessage>(context.organization.id, context.user.id);
  // One reply at a time: a second message sent quickly waits for the first reply, then sees it.
  if (!(await takeTurn(id, { timeoutMs: 12 * 60_000, everyMs: 2000 }))) {
    throw new Error("The previous reply is still running.");
  }
  try {
    return await answer(context, await getOrCreateChat<UIMessage>(context.organization.id, context.user.id), text, channel, options);
  } finally {
    await endReply(id);
  }
}

type TurnOptions = {
  model?: LanguageModel;
  research?: boolean;
  files?: FileUIPart[];
  /** Sends what it says before it starts work ("On it…") straight away, rather than with the reply. */
  acknowledge?: (text: string) => Promise<void>;
};

async function answer(context: ChiefOfStaffContext, chat: Chat<UIMessage>, text: string, channel: Channel, options: TurnOptions): Promise<string> {
  const question: UIMessage = {
    id: generateMessageId(),
    role: "user",
    // Files they sent (already in their library) go with the words, as in the chat panel.
    parts: [{ type: "text", text }, ...(options.files ?? [])],
    metadata: { channel },
  };
  // The model sees the latest messages in full and a summary of the rest.
  const { earlier, older, recent } = await conversationWindow(chat.id, [...chat.messages, question]);
  const { agent, close } = await loadChiefOfStaff(context, { channel, earlier, ...options });
  const messages = await prepareHistory(recent, agent.tools);
  await saveConversation(chat.id, older, messages);

  let finished: UIMessage[] = messages;
  // What it writes, in order, and whether it already went out as an acknowledgement.
  const said: { id: string; text: string; sent: boolean }[] = [];
  try {
    const stream = await createAgentUIStream({
      agent,
      // Files attached in the chat panel are stored as links to the app, which the model can't open: it's told their names.
      uiMessages: await forModel(context.organization.id, messages),
      originalMessages: messages as never,
      generateMessageId,
      onEnd: async ({ messages: all }) => {
        finished = restoreOriginals(all as UIMessage[], messages);
      },
    });
    for await (const chunk of stream) {
      // A failed model call ends the stream with an error chunk rather than throwing.
      if (chunk.type === "error") throw new Error(chunk.errorText);
      if (chunk.type === "text-start") said.push({ id: chunk.id, text: "", sent: false });
      if (chunk.type === "text-delta") {
        const part = said.findLast((p) => p.id === chunk.id);
        if (part) part.text += chunk.delta;
      }
      // Words before a tool call are its acknowledgement: they go out now, while it works.
      if ((chunk.type === "tool-input-start" || chunk.type === "tool-input-available") && options.acknowledge) {
        const early = said.filter((p) => !p.sent);
        early.forEach((p) => (p.sent = true));
        const ack = early.map((p) => p.text.trim()).filter(Boolean).join("\n\n");
        if (ack) await options.acknowledge(ack).catch((error) => console.error("Couldn't send the acknowledgement", error));
      }
    }
    await saveConversation(chat.id, older, await prepareHistory(finished, agent.tools));
  } finally {
    await close();
  }
  if (said.some((p) => p.sent)) {
    // The acknowledgement already went out: the reply is what came after it (nothing more, if that's all it said).
    return said
      .filter((p) => !p.sent)
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return replyText(finished.slice(messages.length - 1)) || "Done.";
}
