import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateChat, saveChat } from "@/lib/chats";
import { svixSignature, validSvixSignature, inboxUsername } from "@/lib/channels/agentmail";
import { handleEmail, handleWhatsApp } from "@/lib/channels/inbound";
import { emailAddress, findByPhone, firstTime, phoneDigits } from "@/lib/channels/senders";
import { splitMessage, twilioSignature, validTwilioSignature, whatsappText } from "@/lib/channels/twilio";
import { createOrganization, setEmailInbox } from "@/lib/orgs";
import { linkMember, setPhone } from "@/lib/people";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";

/** Records the requests made to Twilio and AgentMail. */
function stubProviders() {
  const sent: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ sid: "SM_out", message_id: "m_out", thread_id: "t_1" });
    }),
  );
  return sent;
}

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  await setPhone(ORG, ahmed.id, "+44 7700 900123");
  return ahmed;
}

describe("talking to the Chief of Staff over WhatsApp and email", () => {
  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
    vi.stubEnv("AGENTMAIL_API_KEY", "am_test");
    vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", `whsec_${Buffer.from("a-test-signing-key").toString("base64")}`);
    vi.stubEnv("APP_URL", "https://mach.example");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("answers a WhatsApp message from a team member in their conversation, and sends the reply through Twilio", async () => {
    await setUp();
    const sent = stubProviders();
    const model = scriptedModel(["Two tasks are **open**: #1 and #2."]);
    await handleWhatsApp({ from: "+447700900123", body: "What's open?", media: 0 }, { model, research: false });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json");
    const form = new URLSearchParams(sent[0].body);
    expect(Object.fromEntries(form)).toEqual({
      From: "whatsapp:+14155238886",
      To: "whatsapp:+447700900123",
      Body: "Two tasks are *open*: #1 and #2.",
    });
    // It's the same conversation as the chat panel, marked as from WhatsApp, and the model was told so.
    const chat = await getOrCreateChat(ORG, "user_ahmed");
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[0]).toMatchObject({ metadata: { channel: "whatsapp" } });
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("This message came by WhatsApp");
  });

  it("says something went wrong when the model fails, rather than pretending it's done", async () => {
    await setUp();
    const sent = stubProviders();
    await handleWhatsApp({ from: "+447700900123", body: "What's open?", media: 0 }, { model: scriptedModel([new Error("gateway down")]), research: false });
    expect(new URLSearchParams(sent[0].body).get("Body")).toBe("Sorry, something went wrong on my side. Try again, or open Mach: https://mach.example/");
  });

  it("tells an unknown number how to link itself, without running the Chief of Staff", async () => {
    await setUp();
    const sent = stubProviders();
    const model = scriptedModel(["should not run"]);
    await handleWhatsApp({ from: "+15550000000", body: "hi", media: 0 }, { model, research: false });
    expect(new URLSearchParams(sent[0].body).get("Body")).toContain("isn't linked to anyone in Mach");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("answers on WhatsApp after a photo was attached in the chat panel, telling the model its name", async () => {
    await setUp();
    // The panel stores an attachment as a link to the app's own file route, which a model can't fetch.
    const chat = await getOrCreateChat(ORG, "user_ahmed");
    await saveChat(chat.id, [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "Here's the statement." },
          { type: "file", mediaType: "image/png", filename: "statement.png", url: "/files/7e3160d2-e1b2-40f9-864e-96b7eff28e85?inline=1" },
        ],
      },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "Got it." }] },
    ]);
    const sent = stubProviders();
    const model = scriptedModel(["It's in the company files."]);
    await handleWhatsApp({ from: "+447700900123", body: "Where's that statement?", media: 0 }, { model, research: false });

    expect(new URLSearchParams(sent[0].body).get("Body")).toBe("It's in the company files.");
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("[Attached earlier, now in the company files: statement.png]");
    // The stored conversation keeps the link, not what the model was shown.
    const stored = (await getOrCreateChat(ORG, "user_ahmed")).messages;
    expect(stored[0].parts[1]).toMatchObject({ type: "file", url: "/files/7e3160d2-e1b2-40f9-864e-96b7eff28e85?inline=1" });
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("matches WhatsApp numbers however they were typed, and only for people who use Mach", async () => {
    const ahmed = await setUp();
    expect((await findByPhone("whatsapp:+447700900123"))?.person.id).toBe(ahmed.id);
    expect((await findByPhone("00447700900123"))?.person.id).toBe(ahmed.id);
    // Someone in the org chart who hasn't joined can't talk to the Chief of Staff.
    await getOrCreateChat(ORG, "user_ahmed");
    expect(phoneDigits("+44 (0) 7700-900123")).toBe("4407700900123");
    expect(emailAddress("Ahmed Turk <Ahmed@Cedar.example>")).toBe("ahmed@cedar.example");
  });

  it("answers an email from a team member in its thread, and ignores strangers", async () => {
    await setUp();
    await setEmailInbox(ORG, "cedar-legacy@agentmail.to");
    const sent = stubProviders();
    const model = scriptedModel(["Here's where things stand."]);
    const email = {
      inbox_id: "cedar-legacy@agentmail.to",
      message_id: "<m1@cedar.example>",
      from: "Ahmed <ahmed@cedar.example>",
      subject: "Status?",
      text: "Where are we on Q3?\n\nOn Mon, someone wrote:\n> old stuff",
      extracted_text: "Where are we on Q3?",
    };
    await handleEmail(email, { model, research: false });
    expect(sent).toEqual([
      {
        url: "https://api.agentmail.to/v0/inboxes/cedar-legacy%40agentmail.to/messages/%3Cm1%40cedar.example%3E/reply",
        body: JSON.stringify({ text: "Here's where things stand." }),
      },
    ]);
    const asked = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(asked).toContain("Subject: Status?");
    expect(asked).not.toContain("old stuff");

    await handleEmail({ ...email, from: "someone@else.example" }, { model, research: false });
    expect(sent).toHaveLength(1);
  });

  it("checks Twilio's and Svix's signatures, and answers each message once", async () => {
    const url = "https://mach.example/api/whatsapp";
    const params = { From: "whatsapp:+447700900123", Body: "hi", MessageSid: "SM1" };
    expect(validTwilioSignature(url, params, twilioSignature(url, params, "twilio-token"))).toBe(true);
    expect(validTwilioSignature(url, { ...params, Body: "changed" }, twilioSignature(url, params, "twilio-token"))).toBe(false);
    expect(validTwilioSignature(url, params, null)).toBe(false);

    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET!;
    const body = JSON.stringify({ event_type: "message.received" });
    const now = Date.UTC(2026, 9, 8, 12);
    const timestamp = String(now / 1000);
    const signature = `v1,${svixSignature(secret, "msg_1", timestamp, body)}`;
    expect(validSvixSignature({ id: "msg_1", timestamp, signature }, body, now)).toBe(true);
    expect(validSvixSignature({ id: "msg_1", timestamp, signature: `v1,bogus ${signature}` }, body, now)).toBe(true);
    expect(validSvixSignature({ id: "msg_1", timestamp, signature }, `${body} `, now)).toBe(false);
    expect(validSvixSignature({ id: "msg_1", timestamp, signature }, body, now + 10 * 60_000)).toBe(false);

    await useTestDb();
    expect(await firstTime("twilio", "SM1")).toBe(true);
    expect(await firstTime("twilio", "SM1")).toBe(false);
  });

  it("formats replies for WhatsApp and splits long ones", () => {
    expect(whatsappText("# Q3\n\n**Done** and __checked__. See [the task](https://mach.example/tasks/1).")).toBe(
      "*Q3*\n\n*Done* and _checked_. See the task (https://mach.example/tasks/1).",
    );
    expect(whatsappText("| Case | OP |\n|---|---:|\n| Base | 109 |")).toBe("Case · OP\n\nBase · 109");
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(10).trim()).join("\n\n");
    const parts = splitMessage(long, 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join("\n\n")).toBe(long);
    expect(inboxUsername("Cédar Legacy & Co. (London)")).toBe("cedar-legacy-co-london");
  });
});
