import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateChat, loadChat } from "@/lib/chats";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";
const user = { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" };
const model = { current: undefined as MockLanguageModelV4 | undefined };

// Outside Next there's no request to run work after: run it now, and keep it to wait for.
const afterwards: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown> | (() => unknown)) => void afterwards.push(Promise.resolve(typeof task === "function" ? task() : task)),
}));

vi.mock("@/lib/session", () => ({
  getSessionContext: async () => ({ organization: await getOrganization(ORG), user, person: null, isAdmin: true }),
}));
vi.mock("@/lib/agents/chief-of-staff", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agents/chief-of-staff")>();
  return {
    ...original,
    createChiefOfStaff: (context: Parameters<typeof original.createChiefOfStaff>[0]) =>
      original.createChiefOfStaff(context, { model: model.current, research: true }),
  };
});

const { POST } = await import("./route");

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function replyingWith(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: text },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ],
      }),
    }),
  });
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
}

const userMessage = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("POST /api/chat", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("stores the conversation and continues it from the database", async () => {
    const chat = await getOrCreateChat(ORG, user.id);
    expect((await getOrCreateChat(ORG, user.id)).id).toBe(chat.id);

    model.current = replyingWith("Hello! What does Cedar Legacy do?");
    await (await post({ id: chat.id, message: userMessage("u1", "Hi") })).text();

    let stored = (await loadChat(chat.id, ORG, user.id))!.messages;
    expect(stored.map((m) => [m.role, m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)])).toEqual([
      ["user", ["Hi"]],
      ["assistant", ["Hello! What does Cedar Legacy do?"]],
    ]);
    expect(stored[1].id).toMatch(/^msg/);

    model.current = replyingWith("Got it.");
    await (await post({ id: chat.id, message: userMessage("u2", "We're a family office.") })).text();

    // The model received the stored history plus the new message.
    const prompt = JSON.stringify(model.current.doStreamCalls[0].prompt);
    expect(prompt).toContain("Hello! What does Cedar Legacy do?");
    expect(prompt).toContain("We're a family office.");

    stored = (await loadChat(chat.id, ORG, user.id))!.messages;
    expect(stored.map((m) => m.id).slice(0, 3)).toEqual(["u1", stored[1].id, "u2"]);
    expect(stored).toHaveLength(4);
  });

  it("repairs stored gateway search results instead of failing", async () => {
    const chat = await getOrCreateChat(ORG, user.id);
    const { saveChat } = await import("@/lib/chats");
    await saveChat(chat.id, [
      userMessage("u1", "Hi") as UIMessage,
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-web_search",
            toolCallId: "call_1",
            state: "output-available",
            providerExecuted: true,
            input: { objective: "Cedar Legacy" },
            output: { search_id: "s1", results: [{ url: "https://a.example", title: "A", excerpts: ["a"] }] },
          },
          { type: "text", text: "You're a family office." },
        ],
      } as unknown as UIMessage,
    ]);

    model.current = replyingWith("Great.");
    const response = await post({ id: chat.id, message: userMessage("u2", "Yes") });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Great.");

    const stored = (await loadChat(chat.id, ORG, user.id))!.messages;
    const search = stored[1].parts.find((p) => p.type === "tool-web_search") as { output: { searchId: string } };
    expect(search.output.searchId).toBe("s1");
  });

  it("finishes and stores the reply when nobody reads it, as when the panel is closed", async () => {
    const chat = await getOrCreateChat(ORG, user.id);
    model.current = replyingWith("Done while you were away.");
    const response = await post({ id: chat.id, message: userMessage("u1", "Hi") });
    await response.body?.cancel();
    await Promise.all(afterwards.splice(0));

    const stored = (await loadChat(chat.id, ORG, user.id))!.messages;
    expect(stored.at(-1)?.parts.find((p) => p.type === "text")).toMatchObject({ text: "Done while you were away." });
  });

  it("ignores anything but a plain user text message", async () => {
    const chat = await getOrCreateChat(ORG, user.id);
    expect((await post({ id: chat.id, message: { id: "x", role: "assistant", parts: [] } })).status).toBe(400);
    expect((await post({ id: chat.id, message: { id: "x", role: "user", parts: [{ type: "tool-save_person" }] } })).status).toBe(400);
    expect((await post({ id: chat.id })).status).toBe(400);
  });

  it("refuses someone else's conversation", async () => {
    const theirs = await getOrCreateChat(ORG, "user_someone_else");
    expect((await post({ id: theirs.id, message: userMessage("u1", "Hi") })).status).toBe(404);
  });
});
