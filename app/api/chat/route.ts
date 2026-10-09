import { consumeStream, createAgentUIStreamResponse, type UIMessage } from "ai";
import { after } from "next/server";

import { forModel, MAX_CHAT_ATTACHMENTS, restoreOriginals, saveChatAttachments, type ChatUpload } from "@/lib/agents/chat-attachments";
import { generateMessageId, loadChiefOfStaff } from "@/lib/agents/cos-turn";
import { prepareHistory } from "@/lib/agents/history";
import { endReply, loadChat, saveChat, startReply, stopRequested, waitForStoppedReply } from "@/lib/chats";
import { getSessionContext } from "@/lib/session";

// Long enough for a reply that searches the web, uses the Chief of Staff's
// sandbox or hands a job to the browser agent (the most a function may run on
// Vercel Pro). Agent runs it starts are separate workflows (see
// lib/agents/dispatch.ts).
export const maxDuration = 800;

/** Accepts only a plain user text message from the browser; history comes from the database. */
function parseUserMessage(value: unknown, hasFiles: boolean): UIMessage | null {
  const message = value as { id?: unknown; role?: unknown; parts?: unknown } | null;
  if (!message || typeof message.id !== "string" || message.role !== "user" || !Array.isArray(message.parts)) {
    return null;
  }
  const parts = message.parts
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .filter((part) => part.text.trim())
    .map((part) => ({ type: "text" as const, text: part.text }));
  return parts.length > 0 || hasFiles ? { id: message.id, role: "user", parts } : null;
}

/** Files attached to the message: uploaded to Blob first (/api/uploads), named by the browser. */
function parseUploads(value: unknown): ChatUpload[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) return null;
  const uploads = value.filter(
    (u): u is ChatUpload => typeof u?.name === "string" && u.name.trim() !== "" && typeof u?.blobPathname === "string",
  );
  return uploads.length === value.length ? uploads : null;
}

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return new Response("Create your company first.", { status: 409 });

  const body = (await request.json().catch(() => null)) as { id?: unknown; message?: unknown; uploads?: unknown; viewing?: unknown } | null;
  // The screen they're on (a path in the app); what's there is looked up on the server.
  const viewing = typeof body?.viewing === "string" && body.viewing.startsWith("/") && body.viewing.length < 300 ? body.viewing : undefined;
  const uploads = parseUploads(body?.uploads);
  const userMessage = parseUserMessage(body?.message, Boolean(uploads?.length));
  if (typeof body?.id !== "string" || !userMessage || !uploads) return new Response("Invalid message.", { status: 400 });

  if (!(await loadChat(body.id, context.organization.id, context.user.id))) return new Response("Conversation not found.", { status: 404 });
  // Sent with Send now: the reply it stopped saves first, so this one starts from it (and doesn't overwrite it).
  await waitForStoppedReply(body.id);
  const chat = (await loadChat(body.id, context.organization.id, context.user.id))!;

  let agent;
  let close: () => Promise<void>;
  try {
    ({ agent, close } = await loadChiefOfStaff({ organization: context.organization, user: context.user, person: context.person }, { viewing }));
  } catch (error) {
    // Configuration problems (e.g. no model set) are shown to the user as-is.
    return new Response(error instanceof Error ? error.message : "Could not start the Chief of Staff.", {
      status: 500,
    });
  }

  // Attached files go into the company's file library; the message keeps a link to each.
  if (uploads.length) {
    try {
      userMessage.parts.push(...(await saveChatAttachments(context.organization.id, context.person.id, uploads)));
    } catch (error) {
      await close();
      return new Response(error instanceof Error ? error.message : "Couldn't attach those files.", { status: 400 });
    }
  }

  // Resending a message (e.g. retrying after an error) replaces it and anything after it.
  const history = await prepareHistory(chat.messages, agent.tools);
  const retryIndex = history.findIndex((message) => message.id === userMessage.id);
  const retried = retryIndex === -1 ? null : history[retryIndex];
  // A retry sends the text again but not the files, which are already saved with the first try.
  if (retried && !uploads.length) userMessage.parts.push(...retried.parts.filter((p) => p.type === "file"));
  const messages = [...(retryIndex === -1 ? history : history.slice(0, retryIndex)), userMessage];
  // Save the question first so it isn't lost if the run fails.
  await saveChat(chat.id, messages);

  // The reply runs to the end even if the browser goes away (the panel closed, a reload): it isn't tied to
  // the request, the stream is read to its end after the response, and only Stop (stopChatAction) ends it early.
  await startReply(chat.id);
  const stop = new AbortController();
  const watch = setInterval(() => {
    stopRequested(chat.id)
      .then((requested) => requested && stop.abort())
      .catch(() => {});
  }, 2000);
  const unwatch = setTimeout(() => clearInterval(watch), maxDuration * 1000);

  return createAgentUIStreamResponse({
    agent,
    uiMessages: await forModel(context.organization.id, messages),
    abortSignal: stop.signal,
    generateMessageId,
    consumeSseStream: ({ stream }) => after(consumeStream({ stream })),
    onEnd: async ({ messages: finished }) => {
      clearInterval(watch);
      clearTimeout(unwatch);
      // What the model was shown (attached images as data) is never stored; the conversation keeps its file links.
      await saveChat(chat.id, await prepareHistory(restoreOriginals(finished, messages), agent.tools));
      await endReply(chat.id);
      // Stop the workspace sandbox if this turn used it (it keeps running while a sign-in waits for a code).
      await close();
    },
    // Internal tool for now, so show the real reason (e.g. a missing AI Gateway key).
    onError: (error) => (error instanceof Error ? error.message : "Something went wrong."),
  });
}
