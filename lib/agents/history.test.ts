import { validateUIMessages, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "./chief-of-staff";
import { prepareHistory } from "./history";

const agent = createChiefOfStaff(
  {
    organization: { id: "org_1", name: "Cedar Legacy", website: null, domain: null, onboardingCompletedAt: null },
    user: { id: "user_1", email: "ahmed@cedar.example", name: "Ahmed" },
    profile: "",
  },
  { model: "test/model" },
);
const tools = agent.tools;

// The exact shape AI Gateway returned for a Parallel search in production.
const rawSearchOutput = {
  search_id: "search_6b10a03b45882a672995c17b733f03b8",
  results: [
    {
      url: "https://www.cedarlegacy.com/",
      title: "Cedar Legacy",
      excerpts: ["# Cedar Legacy\nCedar Legacy is a family office.", "Based in New York City."],
    },
  ],
  usage: [{ name: "sku_search", count: 1 }],
};

function assistantWith(part: object, id = "a1"): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "step-start" }, part, { type: "text", text: "You're a family office. Right?" }],
  } as UIMessage;
}

const searchPart = (output: object) => ({
  type: "tool-web_search",
  toolCallId: "call_1",
  state: "output-available",
  providerExecuted: true,
  input: { objective: "What is Cedar Legacy?" },
  output,
});

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("prepareHistory", () => {
  it("repairs the gateway's raw search results into the declared shape", async () => {
    const messages = [user("u1", "Hi"), assistantWith(searchPart(rawSearchOutput)), user("u2", "Yes")];
    await expect(validateUIMessages({ messages, tools })).rejects.toThrow(/web_search/);

    const prepared = await prepareHistory(messages, tools);
    expect(prepared.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect((prepared[1].parts[1] as { output: unknown }).output).toEqual({
      searchId: "search_6b10a03b45882a672995c17b733f03b8",
      results: [
        {
          url: "https://www.cedarlegacy.com/",
          title: "Cedar Legacy",
          excerpt: "# Cedar Legacy\nCedar Legacy is a family office.\n\nBased in New York City.",
        },
      ],
    });
    await expect(validateUIMessages({ messages: prepared, tools })).resolves.toHaveLength(3);
  });

  it("leaves results that are already valid untouched", async () => {
    const valid = { searchId: "s1", results: [{ url: "https://a.example", title: "A", excerpt: "a" }] };
    const messages = [assistantWith(searchPart(valid))];
    const prepared = await prepareHistory(messages, tools);
    expect(prepared[0].parts[1]).toBe(messages[0].parts[1]);
  });

  it("repairs raw page fetch results", async () => {
    const fetchPart = {
      type: "tool-fetch_page",
      toolCallId: "call_2",
      state: "output-available",
      providerExecuted: true,
      input: { url: "https://www.cedarlegacy.com/" },
      output: {
        id: "fetch_1",
        content: "# Cedar Legacy",
        content_type: "text/markdown",
        encoding: "utf-8",
        headers: { "content-type": "text/html" },
        status_code: 200,
      },
    };
    const prepared = await prepareHistory([assistantWith(fetchPart)], tools);
    expect((prepared[0].parts[1] as { output: unknown }).output).toMatchObject({
      contentType: "text/markdown",
      statusCode: 200,
    });
  });

  it("drops results it can't repair but keeps the rest of the message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prepared = await prepareHistory([assistantWith(searchPart({ nonsense: true }))], tools);
    expect(prepared[0].parts.map((p) => p.type)).toEqual(["step-start", "text"]);
    warn.mockRestore();
  });

  it("drops stored messages that no longer validate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      id: "a2",
      role: "assistant",
      parts: [{ type: "tool-save_person", toolCallId: "c", state: "output-available", input: { nope: 1 }, output: {} }],
    } as unknown as UIMessage;
    const prepared = await prepareHistory([user("u1", "Hi"), broken, user("u2", "Still there?")], tools);
    expect(prepared.map((m) => m.id)).toEqual(["u1", "u2"]);
    warn.mockRestore();
  });
});
