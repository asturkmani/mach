import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { createAgent } from "@/lib/agents/store";
import { getOrCreateChat, takeTurn } from "@/lib/chats";
import { getDb } from "@/lib/db";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember } from "@/lib/people";
import { createTask, updateTask } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

import { getAssistantHours, scheduleWakeup } from "./store";
import { runAssistantWakeups } from "./wake";

const ORG = "org_cedar";
const MINUTE = 60_000;

/** Hours (in UTC) that put right now just after the start of the working day, far from quiet hours. */
function hoursAroundNow() {
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const now = Date.now();
  return { days: [1, 2, 3, 4, 5, 6, 7], start: hhmm(now - 10 * MINUTE), end: hhmm(now + 8 * 60 * MINUTE), quietStart: hhmm(now + 12 * 60 * MINUTE), quietEnd: hhmm(now + 14 * 60 * MINUTE) };
}

/** Records what's sent through Twilio. */
function stubTwilio() {
  const sent: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response("{}", { status: 201 });
    }),
  );
  return sent;
}

const promptOf = (model: ReturnType<typeof scriptedModel>, call = 0) => JSON.stringify(model.doGenerateCalls[call]?.prompt ?? model.doStreamCalls[call]?.prompt);
const wakeups = () => getDb().query<{ reason: string; urgent: boolean; done_at: Date | null; due_at: Date; claimed_at: Date | null }>("select * from assistant_wakeups order by created_at");

describe("the assistant wakes up by itself", () => {
  let sara: string;

  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+14155238886");
    vi.stubEnv("APP_URL", "https://trymach1.app");
    vi.stubEnv("CHIEF_OF_STAFF_MODEL", "test/model");
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    await getDb().query("update organizations set onboarding_completed_at = now() where id = $1", [ORG]);
    sara = (await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" })).id;
    await getDb().query(
      "update people set whatsapp = '447700900123', whatsapp_in_at = now() - interval '2 hours', timezone = 'UTC', work_hours = $2::jsonb where id = $1",
      [sara, JSON.stringify(hoursAroundNow())],
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("tells them on WhatsApp when their work is ready, in its own words, after checking it", async () => {
    const sent = stubTwilio();
    const developer = await createAgent(ORG, { name: "Developer" });
    const task = await createTask(ORG, { title: "Fix the pricing typo", createdBy: { personId: sara }, agents: [developer.id] });
    await updateTask(ORG, task.id, { status: "review", summary: "Typo fixed; PR #7 is open." });
    expect(await wakeups()).toMatchObject([{ reason: "task", urgent: false, done_at: null }]);

    const model = scriptedModel([[["read_task", { number: 1 }]], "#1 is done: PR #7 fixes 'anual'. Merge it? https://trymach1.app/tasks/1"]);
    expect(await runAssistantWakeups({ model, research: false })).toBe(1);

    expect(promptOf(model)).toContain('Task #1 \\"Fix the pricing typo\\" is ready for them to review');
    expect(sent).toHaveLength(1);
    expect(sent[0].get("To")).toBe("whatsapp:+447700900123");
    expect(sent[0].get("Body")).toContain("Merge it?");
    // Only its words join the conversation; the check-in note and its digging don't.
    const chat = await getOrCreateChat(ORG, "user_sara");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: "assistant", metadata: { proactive: true, channel: "whatsapp" } });
    expect(JSON.stringify(chat.messages)).not.toContain("your own check-in");
    expect((await wakeups())[0].done_at).not.toBeNull();
    const [person] = await getDb().query<{ assistant_nudged_at: Date | null }>("select assistant_nudged_at from people where id = $1", [sara]);
    expect(person.assistant_nudged_at).not.toBeNull();
    // Nothing else is due.
    expect(await runAssistantWakeups({ model, research: false })).toBe(0);
  });

  it("stays quiet when there's nothing worth saying", async () => {
    const sent = stubTwilio();
    await scheduleWakeup(ORG, sara, { reason: "check_in", note: "Whether the bank feed caught up" });
    await runAssistantWakeups({ model: scriptedModel(["QUIET"]), research: false });
    expect(sent).toHaveLength(0);
    expect((await getOrCreateChat(ORG, "user_sara")).messages).toHaveLength(0);
    expect((await wakeups())[0].done_at).not.toBeNull();
  });

  it("waits a couple of minutes while they're mid-conversation", async () => {
    stubTwilio();
    await scheduleWakeup(ORG, sara, { reason: "check_in", note: "The import" });
    const { id } = await getOrCreateChat(ORG, "user_sara");
    await takeTurn(id);
    const model = scriptedModel(["Import's done."]);
    await runAssistantWakeups({ model, research: false });
    expect(model.doStreamCalls).toHaveLength(0);
    const [wakeup] = await wakeups();
    expect(wakeup).toMatchObject({ done_at: null, claimed_at: null });
    expect(wakeup.due_at.getTime()).toBeGreaterThan(Date.now() + MINUTE);
  });

  it("writes before WhatsApp's window closes, about something of theirs, once", async () => {
    const sent = stubTwilio();
    await getDb().query("update people set whatsapp_in_at = now() - interval '13 hours' where id = $1", [sara]);
    const model = scriptedModel(["The Q3 pack you asked about on Monday is still waiting on Omar's numbers. Want me to chase him?"]);
    await runAssistantWakeups({ model, research: false });
    expect(promptOf(model)).toContain("It's been quiet");
    expect(promptOf(model)).toContain("This message must go out");
    expect(sent).toHaveLength(1);
    expect(await wakeups()).toMatchObject([{ reason: "keepalive" }]);
    // Until they reply, no more.
    await runAssistantWakeups({ model, research: false });
    expect(sent).toHaveLength(1);
  });

  it("doesn't try once the window has closed, and then writes in the app instead of WhatsApp", async () => {
    const sent = stubTwilio();
    await getDb().query("update people set whatsapp_in_at = now() - interval '30 hours' where id = $1", [sara]);
    await runAssistantWakeups({ model: scriptedModel(["Hi"]), research: false });
    expect(await wakeups()).toHaveLength(0);

    await scheduleWakeup(ORG, sara, { reason: "check_in", note: "The import" });
    await runAssistantWakeups({ model: scriptedModel(["The import finished: 4,210 rows."]), research: false });
    expect(sent).toHaveLength(0);
    expect(JSON.stringify((await getOrCreateChat(ORG, "user_sara")).messages)).toContain("4,210 rows");
  });

  it("uses the approved template once the window has closed, if there is one", async () => {
    vi.stubEnv("TWILIO_WHATSAPP_TEMPLATE_SID", "HX123");
    const sent = stubTwilio();
    await getDb().query("update people set whatsapp_in_at = now() - interval '30 hours' where id = $1", [sara]);
    await scheduleWakeup(ORG, sara, { reason: "check_in", note: "The import" });
    const model = scriptedModel(["The import finished:\n4,210 rows. Want the summary?"]);
    await runAssistantWakeups({ model, research: false });
    expect(promptOf(model)).toContain("inside a notice");
    expect(sent).toHaveLength(1);
    expect(sent[0].get("ContentSid")).toBe("HX123");
    expect(sent[0].get("Body")).toBeNull();
    expect(JSON.parse(sent[0].get("ContentVariables")!)).toEqual({ "1": "Sara", "2": "The import finished: · 4,210 rows. Want the summary?" });
  });

  it("asks for their hours until it knows them, saves them, and sets itself check-ins", async () => {
    await getDb().query("update people set timezone = null, work_hours = null where id = $1", [sara]);
    const organization = (await getOrganization(ORG))!;
    const person = (await getPerson(ORG, sara))!;
    const hours = await getAssistantHours(ORG, sara);
    const model = scriptedModel([
      [
        ["do_action", { action: "me.set_hours", input: { timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", quietStart: "22:00", quietEnd: "07:00" } }],
        ["check_back_later", { about: "Whether the bank feed caught up", minutes: 90 }],
      ],
      "Saved.",
    ]);
    await createChiefOfStaff({ organization, user: { id: "user_sara", email: "sara@cedar.example", name: "Sara" }, person, profile: "", hours }, { model, research: false }).generate({
      prompt: "I'm in Dubai, 8 to 5, nothing after 10pm. And check the bank feed in 90 minutes.",
    });
    expect(promptOf(model)).toContain("You don't know Sara's hours yet");
    expect(await getAssistantHours(ORG, sara)).toMatchObject({ timezone: "Asia/Dubai", saved: true, hours: { start: "08:00", quietStart: "22:00" } });
    const [wakeup] = await wakeups();
    expect(wakeup).toMatchObject({ reason: "check_in", done_at: null });
    expect(wakeup.due_at.getTime()).toBeGreaterThan(Date.now() + 80 * MINUTE);
  });
});
