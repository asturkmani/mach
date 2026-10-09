import "server-only";

import { generateId, type UIMessage } from "ai";

import { getDb } from "@/lib/db";

// Chat history lives on the server: the browser only sends the newest message,
// so it can't rewrite earlier turns or inject tool results.

export type Chat<T extends UIMessage = UIMessage> = { id: string; messages: T[] };

type ChatRow = { id: string; messages: unknown };

/** The signed-in person's conversation with the Chief of Staff, created on first use. */
export async function getOrCreateChat<T extends UIMessage>(organizationId: string, userId: string): Promise<Chat<T>> {
  const [row] = await getDb().query<ChatRow>(
    `insert into chats (id, organization_id, user_id) values ($1, $2, $3)
     on conflict (organization_id, user_id) do update set organization_id = excluded.organization_id
     returning id, messages`,
    [generateId(), organizationId, userId],
  );
  return { id: row.id, messages: row.messages as T[] };
}

/** Loads a chat only if it belongs to this person in this organization. */
export async function loadChat<T extends UIMessage>(
  id: string,
  organizationId: string,
  userId: string,
): Promise<Chat<T> | null> {
  const [row] = await getDb().query<ChatRow>(
    "select id, messages from chats where id = $1 and organization_id = $2 and user_id = $3",
    [id, organizationId, userId],
  );
  return row ? { id: row.id, messages: row.messages as T[] } : null;
}

export async function saveChat(id: string, messages: UIMessage[]): Promise<void> {
  await getDb().query("update chats set messages = $2::jsonb, updated_at = now() where id = $1", [
    id,
    JSON.stringify(messages),
  ]);
}

/**
 * Replies run to the end even if the browser goes away, so Stop asks through
 * the database: a reply clears the request when it starts (startReply) and
 * checks for one while it runs.
 */
export async function requestStop(id: string, organizationId: string, userId: string): Promise<void> {
  await getDb().query("update chats set stop_requested_at = now() where id = $1 and organization_id = $2 and user_id = $3", [
    id,
    organizationId,
    userId,
  ]);
}

export async function stopRequested(id: string): Promise<boolean> {
  const [row] = await getDb().query<{ stop: boolean }>("select stop_requested_at is not null as stop from chats where id = $1", [id]);
  return Boolean(row?.stop);
}

/** A reply starts: any earlier Stop is done with, and the chat is marked as replying until endReply. */
export async function startReply(id: string): Promise<void> {
  await getDb().query("update chats set stop_requested_at = null, reply_started_at = now() where id = $1", [id]);
}

export async function endReply(id: string): Promise<void> {
  await getDb().query("update chats set reply_started_at = null where id = $1", [id]);
}

/**
 * Waits (up to `timeoutMs`) for a reply that was asked to stop to save what it
 * had, so a message sent with Send now doesn't race it: each reply saves the
 * whole conversation when it ends. A reply that was never asked to stop isn't
 * waited for, nor is a mark left by a reply that died (older than a reply can run).
 */
export async function waitForStoppedReply(id: string, { timeoutMs = 20_000, everyMs = 500 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await getDb().query<{ stopping: boolean }>(
      `select reply_started_at > now() - interval '6 minutes' and stop_requested_at is not null as stopping
       from chats where id = $1`,
      [id],
    );
    if (!row?.stopping) return;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
