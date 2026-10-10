import "server-only";

import { generateText, type LanguageModel, type UIMessage } from "ai";

import { companyModel } from "@/lib/ai/company-model";
import { getDb } from "@/lib/db";

// A person's conversation with their assistant never ends (the chat panel and
// WhatsApp are one thread), so the model can't be shown all of it. It sees
// the latest messages in full and a running summary of everything before,
// brought up to date after replies as messages fall out of the window.
// Storage keeps a long tail for the chat panel, trimmed only past what's
// summarized.

/** Messages the model sees in full. */
export const RECENT = 30;
/** The summary catches up once this many messages have fallen out of the window. */
const CATCH_UP = 10;
/** Messages kept in storage for the chat panel. */
const KEEP = 400;
const SUMMARY_LIMIT = 6000;

let summaryModel: LanguageModel | null = null;
/** Tests swap in a scripted model. */
export function setSummaryModel(model: LanguageModel | null): void {
  summaryModel = model;
}

/** Where the window starts: at a person's message, so a reply is never cut from its question. */
export function windowStart(messages: Pick<UIMessage, "role">[]): number {
  if (messages.length <= RECENT) return 0;
  for (let i = messages.length - RECENT; i < messages.length; i++) if (messages[i].role === "user") return i;
  return messages.length - RECENT;
}

/** A message as plain lines for the summary: who said what, and which tools ran. */
function plain(message: UIMessage): string {
  const words = message.parts.flatMap((part) => {
    if (part.type === "text") return [part.text.trim()];
    if (part.type.startsWith("tool-")) return [`[used ${part.type.slice(5)}]`];
    if (part.type === "file") return ["[a file]"];
    return [];
  });
  const text = words.filter(Boolean).join(" ");
  return text ? `${message.role === "user" ? "Them" : "You"}: ${text.slice(0, 3000)}` : "";
}

type Stored = { summary: string; summarizedThrough: string | null; organizationId: string };

async function readSummary(chatId: string): Promise<Stored> {
  const [row] = await getDb().query<{ summary: string; summarized_through: string | null; organization_id: string }>(
    "select summary, summarized_through, organization_id from chats where id = $1",
    [chatId],
  );
  return { summary: row?.summary ?? "", summarizedThrough: row?.summarized_through ?? null, organizationId: row?.organization_id ?? "" };
}

/** Messages past the summary the model can still be shown in full while the summary catches up. */
const MAX_BEHIND = 40;

/**
 * What the model is shown of this conversation: the recent messages in full
 * (`recent`), and the running summary of the ones before (`earlier`). It
 * never waits for the summary: messages the summary doesn't cover yet are
 * shown in full instead (up to MAX_BEHIND more), and catchUpSummary brings it
 * up to date after the reply has gone out. `older` are the messages not
 * shown, which are saved back with the reply.
 */
export async function conversationWindow(
  chatId: string,
  messages: UIMessage[],
): Promise<{ earlier: string; older: UIMessage[]; recent: UIMessage[] }> {
  const start = windowStart(messages);
  const stored = await readSummary(chatId);
  if (start === 0) return { earlier: stored.summary, older: [], recent: messages };
  const covered = coveredUpTo(messages, stored.summarizedThrough);
  const from = Math.min(start, Math.max(covered, start - MAX_BEHIND));
  return { earlier: stored.summary, older: messages.slice(0, from), recent: messages.slice(from) };
}

/** How many of the messages the summary covers (from the start). */
const coveredUpTo = (messages: Pick<UIMessage, "id">[], summarizedThrough: string | null) =>
  summarizedThrough ? messages.findIndex((m) => m.id === summarizedThrough) + 1 : 0;

/**
 * Brings the conversation's summary up to date once enough messages have
 * fallen out of the window. Runs after a reply, so nobody waits for it.
 */
export async function catchUpSummary(chatId: string): Promise<void> {
  const [row] = await getDb().query<{ messages: UIMessage[]; summary: string; summarized_through: string | null; organization_id: string }>(
    "select messages, summary, summarized_through, organization_id from chats where id = $1",
    [chatId],
  );
  if (!row) return;
  const messages = row.messages ?? [];
  const start = windowStart(messages);
  const covered = coveredUpTo(messages, row.summarized_through);
  if (start === 0 || (start - covered < CATCH_UP && (covered > 0 || row.summary))) return;
  const summary = await summarize(row.organization_id, row.summary, messages.slice(covered, start));
  if (!summary) return;
  // Only if nobody else caught it up meanwhile.
  await getDb().query(
    "update chats set summary = $2, summarized_through = $3 where id = $1 and summarized_through is not distinct from $4",
    [chatId, summary, messages[start - 1].id, row.summarized_through],
  );
}

async function summarize(organizationId: string, previous: string, messages: UIMessage[]): Promise<string | null> {
  const model = summaryModel ?? process.env.SUMMARY_MODEL ?? process.env.CHIEF_OF_STAFF_MODEL;
  const text = messages.map(plain).filter(Boolean).join("\n");
  if (!model || !text) return null;
  try {
    const result = await generateText({
      model: companyModel(organizationId, model),
      system:
        "You keep the running summary of an assistant's conversation with one person, which the assistant reads instead of the old messages. Update the summary with the new messages. Keep what will matter later: what they asked for and what was done (task numbers, links, files, decisions, numbers), what they said about themselves and how they like things, and anything still open or promised. Drop small talk and anything finished that won't come up again. Short dated bullet points under a few headings, most recent last. At most 500 words. Write only the summary.",
      prompt: `${previous ? `The summary so far:\n${previous}\n\n` : ""}New messages (oldest first):\n${text}`,
    });
    return result.text.trim().slice(0, SUMMARY_LIMIT) || null;
  } catch (error) {
    console.error("Couldn't summarize the conversation", error);
    return null;
  }
}

/** The conversation as it's stored: a long tail for the chat panel, only ever trimmed past what the summary covers. */
export function forStorage(messages: UIMessage[], summarizedThrough: string | null): UIMessage[] {
  if (messages.length <= KEEP) return messages;
  const covered = summarizedThrough ? messages.findIndex((m) => m.id === summarizedThrough) + 1 : 0;
  return messages.slice(Math.min(covered, messages.length - KEEP));
}

/** Saves a reply's conversation: what wasn't shown, then what was and the reply. */
export async function saveConversation(chatId: string, older: UIMessage[], latest: UIMessage[]): Promise<void> {
  const { summarizedThrough } = await readSummary(chatId);
  const messages = forStorage([...older, ...latest], summarizedThrough);
  await getDb().query("update chats set messages = $2::jsonb, updated_at = now() where id = $1", [chatId, JSON.stringify(messages)]);
}

// ---------------------------------------------------------------------------
// What the assistant knows about the person

export const MEMORY_LIMIT = 4000;

export async function getPersonalMemory(organizationId: string, personId: string): Promise<string> {
  const [row] = await getDb().query<{ memory: string }>("select memory from people where organization_id = $1 and id = $2", [
    organizationId,
    personId,
  ]);
  return row?.memory ?? "";
}

export async function savePersonalMemory(organizationId: string, personId: string, memory: string): Promise<string> {
  const clean = memory.trim().slice(0, MEMORY_LIMIT);
  await getDb().query("update people set memory = $3, updated_at = now() where organization_id = $1 and id = $2", [
    organizationId,
    personId,
    clean,
  ]);
  return clean;
}
