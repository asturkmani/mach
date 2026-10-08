import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { linkMember, savePerson } from "@/lib/people";
import { savePushSubscription } from "@/lib/push";
import { addMention, createTask, updateTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { useTestDb } from "@/test/db";

// What the push service was asked to deliver, by device.
const delivered: { endpoint: string; payload: Record<string, unknown> }[] = [];
const gone = new Set<string>();
vi.mock("web-push", () => ({
  default: {
    sendNotification: async (subscription: { endpoint: string }, payload: string) => {
      if (gone.has(subscription.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      delivered.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  },
}));

const ORG = "org_cedar";
const device = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: "BPkey", auth: "authkey" } });

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const lina = await savePerson(ORG, { name: "Lina", role: "Analyst" });
  return { ahmed, lina };
}

describe("push notifications", () => {
  beforeEach(async () => {
    await useTestDb();
    delivered.length = 0;
    gone.clear();
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKey");
    vi.stubEnv("VAPID_PRIVATE_KEY", "privateKey");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("tells a task's people when it starts waiting on them, with what waits on them for the app's icon", async () => {
    const { ahmed, lina } = await setUp();
    await savePushSubscription(ORG, ahmed.id, device("ahmed-phone"));
    await savePushSubscription(ORG, ahmed.id, device("ahmed-laptop"));
    await savePushSubscription(ORG, lina.id, device("lina-phone"));
    const task = await createTask(ORG, { title: "Q3 capital call", status: "in_progress", people: [ahmed.id] });

    await updateTask(ORG, task.id, { status: "review", summary: "Capital call drafted: €2.4m due 14 Nov." });
    expect(delivered.map((d) => d.endpoint).sort()).toEqual(["https://push.example/ahmed-laptop", "https://push.example/ahmed-phone"]);
    expect(delivered[0].payload).toEqual({
      title: `#${task.number} is ready for review`,
      body: "Capital call drafted: €2.4m due 14 Nov.",
      url: `/tasks/${task.number}`,
      tag: `task-${task.id}`,
      badge: 1,
    });

    // Only a change into waiting or review notifies: not staying there, nor other changes.
    delivered.length = 0;
    await updateTask(ORG, task.id, { status: "review" });
    await updateTask(ORG, task.id, { title: "Q3 capital call (Fund II)" });
    await updateTask(ORG, task.id, { status: "done" });
    expect(delivered).toEqual([]);

    await updateTask(ORG, task.id, { status: "waiting", summary: "Which bank account?" });
    expect(delivered.map((d) => d.payload.title)).toEqual([`#${task.number} needs your answer`, `#${task.number} needs your answer`]);
  });

  it("tells someone they were mentioned", async () => {
    const { ahmed, lina } = await setUp();
    await savePushSubscription(ORG, lina.id, device("lina-phone"));
    const task = await createTask(ORG, { title: "Brookfield NAV", status: "in_progress", people: [ahmed.id] });
    await addMention(task.id, lina.id, "Ahmed");
    expect(delivered).toEqual([
      {
        endpoint: "https://push.example/lina-phone",
        payload: { title: `Ahmed mentioned you on #${task.number}`, body: "Brookfield NAV", url: `/tasks/${task.number}`, tag: `mention-${task.id}`, badge: 1 },
      },
    ]);
  });

  it("forgets a device the push service says is gone, and sends nothing without push set up", async () => {
    const { ahmed } = await setUp();
    await savePushSubscription(ORG, ahmed.id, device("old-phone"));
    gone.add("https://push.example/old-phone");
    const task = await createTask(ORG, { title: "K-1s", status: "in_progress", people: [ahmed.id] });
    await updateTask(ORG, task.id, { status: "review" });
    expect(await getDb().query("select endpoint from push_subscriptions")).toEqual([]);

    vi.unstubAllEnvs();
    await savePushSubscription(ORG, ahmed.id, device("new-phone"));
    await updateTask(ORG, task.id, { status: "waiting" });
    expect(delivered).toEqual([]);
  });

  it("only takes https push endpoints", async () => {
    const { ahmed } = await setUp();
    await expect(savePushSubscription(ORG, ahmed.id, { endpoint: "http://push.example/x", keys: { p256dh: "a", auth: "b" } })).rejects.toThrow(/https/);
  });
});
