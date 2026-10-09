import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent } from "@/lib/agents/store";
import { getOrCreateChat } from "@/lib/chats";
import { getDb } from "@/lib/db";
import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { addMessage, createTask, updateTask } from "@/lib/tasks";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";

describe("work asked for over WhatsApp", () => {
  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+14155238886");
    vi.stubEnv("APP_URL", "https://trymach1.app");
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports back on WhatsApp, and into the same chat, when it's ready", async () => {
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    await getDb().query("update people set whatsapp = '447700900123' where id = $1", [sara.id]);
    const developer = await createAgent(ORG, { name: "Developer" });
    const sent: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(new URLSearchParams(String(init.body)));
        return new Response("{}", { status: 201 });
      }),
    );

    const asked = await createTask(ORG, { title: "Fix the pricing typo", createdBy: { personId: sara.id }, agents: [developer.id], replyByWhatsApp: true });
    const quiet = await createTask(ORG, { title: "Something else", createdBy: { personId: sara.id }, agents: [developer.id] });
    await addMessage(asked.id, { author: "Developer", agentId: developer.id, kind: "result", body: "Fixed 'anual'. PR: https://github.com/cedar/site/pull/7" });
    await updateTask(ORG, asked.id, { status: "review", summary: "Typo fixed; PR #7 is open." });
    await updateTask(ORG, quiet.id, { status: "review" });

    expect(sent).toHaveLength(1);
    expect(sent[0].get("To")).toBe("whatsapp:+447700900123");
    expect(sent[0].get("Body")).toContain("#1 Fix the pricing typo is done.");
    expect(sent[0].get("Body")).toContain("https://github.com/cedar/site/pull/7");
    expect(sent[0].get("Body")).toContain("https://trymach1.app/tasks/1");
    const chat = await getOrCreateChat(ORG, "user_sara");
    expect(JSON.stringify(chat.messages.at(-1))).toContain("pull/7");
  });
});
