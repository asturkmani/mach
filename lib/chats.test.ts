import { beforeEach, describe, expect, it } from "vitest";

import { endReply, getOrCreateChat, requestStop, stopRequested, takeTurn } from "@/lib/chats";
import { getDb } from "@/lib/db";
import { createOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";
const USER = "user_ahmed";

describe("one Chief of Staff reply at a time", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("makes a second message wait for the reply in progress, then clears any Stop", async () => {
    const chat = await getOrCreateChat(ORG, USER);
    expect(await takeTurn(chat.id)).toBe(true);
    await requestStop(chat.id, ORG, USER);
    expect(await stopRequested(chat.id)).toBe(true);

    let taken = false;
    const waiting = takeTurn(chat.id, { everyMs: 20 }).then((ok) => (taken = ok));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(taken).toBe(false);
    await endReply(chat.id);
    await waiting;
    expect(taken).toBe(true);
    expect(await stopRequested(chat.id)).toBe(false);
  });

  it("gives up after a while, and takes over a turn left by a reply that died", async () => {
    const chat = await getOrCreateChat(ORG, USER);
    await takeTurn(chat.id);
    expect(await takeTurn(chat.id, { timeoutMs: 100, everyMs: 20 })).toBe(false);
    await getDb().query("update chats set reply_started_at = now() - interval '20 minutes' where id = $1", [chat.id]);
    expect(await takeTurn(chat.id, { timeoutMs: 100, everyMs: 20 })).toBe(true);
  });
});
