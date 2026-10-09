import { beforeEach, describe, expect, it } from "vitest";

import { endReply, getOrCreateChat, requestStop, startReply, stopRequested, waitForStoppedReply } from "@/lib/chats";
import { createOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";
const USER = "user_ahmed";

describe("stopping a Chief of Staff reply", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("lets a message sent with Send now wait for the reply it stopped to save", async () => {
    const chat = await getOrCreateChat(ORG, USER);
    await startReply(chat.id);
    await requestStop(chat.id, ORG, USER);
    expect(await stopRequested(chat.id)).toBe(true);

    let waited = false;
    const waiting = waitForStoppedReply(chat.id, { everyMs: 20 }).then(() => (waited = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(waited).toBe(false);
    await endReply(chat.id);
    await waiting;
    expect(waited).toBe(true);

    // The next reply starts with the Stop cleared.
    await startReply(chat.id);
    expect(await stopRequested(chat.id)).toBe(false);
  });

  it("doesn't wait for a reply nobody stopped, or one that never ended", async () => {
    const chat = await getOrCreateChat(ORG, USER);
    await startReply(chat.id);
    const started = Date.now();
    await waitForStoppedReply(chat.id, { timeoutMs: 2000, everyMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);

    await requestStop(chat.id, ORG, USER);
    await waitForStoppedReply(chat.id, { timeoutMs: 150, everyMs: 20 });
  });
});
