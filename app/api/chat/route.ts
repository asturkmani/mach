import { createAgentUIStreamResponse, createIdGenerator, type UIMessage } from "ai";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { prepareHistory } from "@/lib/agents/history";
import { listAgents } from "@/lib/agents/store";
import { loadChat, saveChat } from "@/lib/chats";
import { loadProfile } from "@/lib/profile/store";
import { getSessionContext } from "@/lib/session";
import { listTasks } from "@/lib/tasks";

// Long enough for a reply that searches the web. Agent runs it starts are
// separate workflows (see lib/agents/dispatch.ts).
export const maxDuration = 300;

const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });

/** Accepts only a plain user text message from the browser; history comes from the database. */
function parseUserMessage(value: unknown): UIMessage | null {
  const message = value as { id?: unknown; role?: unknown; parts?: unknown } | null;
  if (!message || typeof message.id !== "string" || message.role !== "user" || !Array.isArray(message.parts)) {
    return null;
  }
  const parts = message.parts
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => ({ type: "text" as const, text: part.text }));
  return parts.some((part) => part.text.trim()) ? { id: message.id, role: "user", parts } : null;
}

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Create your company first.", { status: 409 });

  const body = (await request.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
  const userMessage = parseUserMessage(body?.message);
  if (typeof body?.id !== "string" || !userMessage) return new Response("Invalid message.", { status: 400 });

  const chat = await loadChat(body.id, context.organization.id, context.user.id);
  if (!chat) return new Response("Conversation not found.", { status: 404 });

  let agent;
  try {
    const [profile, agents, tasks] = await Promise.all([
      loadProfile(context.organization.id),
      listAgents(context.organization.id),
      listTasks(context.organization.id, { closedLimit: 0 }),
    ]);
    agent = createChiefOfStaff({
      organization: context.organization,
      user: context.user,
      person: context.person,
      profile,
      agents,
      openTasks: tasks,
    });
  } catch (error) {
    // Configuration problems (e.g. no model set) are shown to the user as-is.
    return new Response(error instanceof Error ? error.message : "Could not start the Chief of Staff.", {
      status: 500,
    });
  }

  // Resending a message (e.g. retrying after an error) replaces it and anything after it.
  const history = await prepareHistory(chat.messages, agent.tools);
  const retryIndex = history.findIndex((message) => message.id === userMessage.id);
  const messages = [...(retryIndex === -1 ? history : history.slice(0, retryIndex)), userMessage];
  // Save the question first so it isn't lost if the run fails.
  await saveChat(chat.id, messages);

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal: request.signal,
    generateMessageId,
    onEnd: async ({ messages: finished }) => {
      await saveChat(chat.id, await prepareHistory(finished, agent.tools));
    },
    // Internal tool for now, so show the real reason (e.g. a missing AI Gateway key).
    onError: (error) => (error instanceof Error ? error.message : "Something went wrong."),
  });
}
