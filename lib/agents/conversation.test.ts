import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chiefOfStaffTurn } from "@/lib/agents/cos-turn";
import { getOrCreateChat, saveChat } from "@/lib/chats";
import { getDb } from "@/lib/db";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

import { catchUpSummary, conversationWindow, forStorage, getPersonalMemory, RECENT, setSummaryModel, windowStart } from "./conversation";

const ORG = "org_cedar";
const user = { id: "user_sara", email: "sara@cedar.example", name: "Sara" };

const say = (i: number): UIMessage[] => [
  { id: `q${i}`, role: "user", parts: [{ type: "text", text: `Question ${i}` }] },
  { id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `Answer ${i}` }] },
];
const thread = (pairs: number) => Array.from({ length: pairs }, (_, i) => say(i)).flat();

describe("a conversation that never ends", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => setSummaryModel(null));

  it("never makes a reply wait for the summary: it catches up afterwards, from where it left off", async () => {
    expect(windowStart(thread(10))).toBe(0);
    const long = thread(40);
    const start = windowStart(long);
    expect(long.length - start).toBeLessThanOrEqual(RECENT);
    expect(long[start].role).toBe("user");

    const { id } = await getOrCreateChat(ORG, user.id);
    await saveChat(id, long);
    const summarizer = scriptedModel(["- Sara asked questions 0 to 24; all answered."]);
    setSummaryModel(summarizer);
    // Before the summary exists, what it would cover is shown in full instead (no model call).
    const before = await conversationWindow(id, long);
    expect(before.earlier).toBe("");
    expect(before.recent).toHaveLength(long.length - start + 40); // up to 40 more than usual
    expect(summarizer.doGenerateCalls).toHaveLength(0);

    // After the reply, it catches up; then only the recent messages are shown in full.
    await catchUpSummary(id);
    const window = await conversationWindow(id, long);
    expect(window.earlier).toBe("- Sara asked questions 0 to 24; all answered.");
    expect(window.older).toHaveLength(start);
    expect(window.recent[0].id).toBe(long[start].id);
    expect(JSON.stringify(summarizer.doGenerateCalls[0].prompt)).toContain("Them: Question 0");

    // A few more messages don't redo it: they're shown in full. Enough of them bring it up to date.
    await saveChat(id, thread(42));
    await catchUpSummary(id);
    const few = await conversationWindow(id, thread(42));
    expect(few.earlier).toBe("- Sara asked questions 0 to 24; all answered.");
    expect(few.older).toHaveLength(start);
    expect(summarizer.doGenerateCalls).toHaveLength(1);
    setSummaryModel(scriptedModel(["- Up to question 34."]));
    await saveChat(id, thread(46));
    await catchUpSummary(id);
    const later = await conversationWindow(id, thread(46));
    expect(later.earlier).toBe("- Up to question 34.");
    const [row] = await getDb().query<{ summarized_through: string }>("select summarized_through from chats where id = $1", [id]);
    expect(row.summarized_through).toBe(later.older.at(-1)!.id);
  });

  it("keeps a long tail in storage, trimming only what the summary covers", () => {
    const huge = thread(300);
    expect(forStorage(huge, null)).toHaveLength(600);
    expect(forStorage(huge, "a250")).toHaveLength(400);
    expect(forStorage(thread(100), "a90")).toHaveLength(200);
  });

  it("keeps notes about the person, read only in their own conversation", async () => {
    const sara = await linkMember(ORG, user);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const notes = "- Prefers one-line answers\n- Looks after the Lebanon entities";
    const model = scriptedModel([[["do_action", { action: "me.set_notes", input: { notes } }]], "Noted."]);
    await chiefOfStaffTurn({ organization, user, person: sara }, "Keep answers to one line. I look after the Lebanon entities.", "whatsapp", { model, research: false });
    expect(await getPersonalMemory(ORG, sara.id)).toBe(notes);

    // The next turn reads them, and they're in nobody else's.
    const next = scriptedModel(["Sure."]);
    await chiefOfStaffTurn({ organization, user, person: sara }, "Hi", "whatsapp", { model: next, research: false });
    expect(JSON.stringify(next.doGenerateCalls[0].prompt)).toContain("Looks after the Lebanon entities");
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    const his = scriptedModel(["Hello."]);
    await chiefOfStaffTurn({ organization, user: { id: "user_omar", email: "omar@cedar.example", name: "Omar" }, person: omar }, "Hi", "whatsapp", { model: his, research: false });
    expect(JSON.stringify(his.doGenerateCalls[0].prompt)).not.toContain("Lebanon");
  });

  it("summarizes a long WhatsApp thread instead of sending all of it", async () => {
    const sara = await linkMember(ORG, user);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const chat = await getOrCreateChat(ORG, user.id);
    await saveChat(chat.id, thread(40));
    setSummaryModel(scriptedModel(["- Earlier: questions 0 to 24 answered."]));
    await catchUpSummary(chat.id); // after an earlier reply
    const model = scriptedModel(["Here you go."]);
    await chiefOfStaffTurn({ organization, user, person: sara }, "And the next one?", "whatsapp", { model, research: false });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Earlier: questions 0 to 24 answered.");
    expect(prompt).not.toContain('"Question 3"');
    expect(prompt).toContain("Question 39");
    // Everything is still stored for the chat panel.
    expect((await getOrCreateChat(ORG, user.id)).messages).toHaveLength(82);
  });
});
