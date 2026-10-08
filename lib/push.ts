import "server-only";

import webpush from "web-push";

import { appUrl } from "@/lib/app-url";
import { getDb } from "@/lib/db";

// Push notifications to the phones and browsers people turned them on for:
// they arrive while Mach is closed, open the task when tapped, and set the
// count of what waits on them on the app's icon. Signed with the VAPID key
// pair in VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (`npx web-push generate-vapid-keys`);
// without it, Mach doesn't offer push and sends nothing.

export type PushMessage = { title: string; body: string; url: string; tag?: string };

export type DeviceSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export const pushConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

/** The public half of the key pair, which a browser subscribes with; null when push isn't set up. */
export const pushPublicKey = () => (pushConfigured() ? process.env.VAPID_PUBLIC_KEY! : null);

export async function savePushSubscription(
  organizationId: string,
  personId: string,
  subscription: DeviceSubscription,
  userAgent = "",
): Promise<void> {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("A push endpoint must be https.");
  if (!subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("The subscription is missing its keys.");
  await getDb().query(
    `insert into push_subscriptions (organization_id, person_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint, person_id) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [organizationId, personId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent.slice(0, 300)],
  );
}

export async function removePushSubscription(personId: string, endpoint: string): Promise<void> {
  await getDb().query("delete from push_subscriptions where person_id = $1 and endpoint = $2", [personId, endpoint]);
}

/**
 * Sends a notification to every device of these people. `badge` gives each
 * person's count of what waits on them, for the app's icon. Never throws: a
 * notification that can't be delivered mustn't stop the work that caused it.
 * Devices the push service says are gone are forgotten.
 */
export async function pushToPeople(
  organizationId: string,
  personIds: string[],
  message: PushMessage,
  options: { badge?: (personId: string) => Promise<number> } = {},
): Promise<number> {
  if (!pushConfigured() || personIds.length === 0) return 0;
  try {
    const devices = await getDb().query<{ person_id: string; endpoint: string; p256dh: string; auth: string }>(
      "select person_id, endpoint, p256dh, auth from push_subscriptions where organization_id = $1 and person_id = any($2::uuid[])",
      [organizationId, personIds],
    );
    if (!devices.length) return 0;
    const badges = new Map<string, number | undefined>();
    for (const personId of new Set(devices.map((d) => d.person_id))) {
      badges.set(personId, await options.badge?.(personId).catch(() => undefined));
    }
    const results = await deliverPushes(
      devices.map((d) => ({
        endpoint: d.endpoint,
        p256dh: d.p256dh,
        auth: d.auth,
        payload: JSON.stringify({ ...message, badge: badges.get(d.person_id) }),
      })),
    );
    let sent = 0;
    for (const [i, result] of results.entries()) {
      if (result === "sent") sent++;
      else if (result === "gone") await removePushSubscription(devices[i].person_id, devices[i].endpoint);
    }
    return sent;
  } catch (error) {
    console.error("Push notifications failed", error);
    return 0;
  }
}

/**
 * Hands each notification to its device's push service. A step: agent runs
 * change tasks from inside a workflow, which can't load web-push itself; a
 * step called anywhere else simply runs.
 */
async function deliverPushes(
  pushes: { endpoint: string; p256dh: string; auth: string; payload: string }[],
): Promise<("sent" | "gone" | "failed")[]> {
  "use step";
  const vapidDetails = { subject: vapidSubject(), publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! };
  return Promise.all(
    pushes.map(async (push) => {
      try {
        await webpush.sendNotification({ endpoint: push.endpoint, keys: { p256dh: push.p256dh, auth: push.auth } }, push.payload, {
          vapidDetails,
          TTL: 60 * 60 * 24,
          urgency: "high",
          timeout: 5000,
        });
        return "sent" as const;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return "gone" as const;
        console.error("Push notification failed", status ?? error);
        return "failed" as const;
      }
    }),
  );
}

/** Who push services can contact about these notifications: VAPID_SUBJECT, else the app's address. */
function vapidSubject(): string {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const app = appUrl("");
  return app.startsWith("https://") ? app : "mailto:notifications@mach.invalid";
}
