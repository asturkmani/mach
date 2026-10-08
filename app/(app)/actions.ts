"use server";

import { signOut } from "@workos-inc/authkit-nextjs";

import { requestStop } from "@/lib/chats";
import { removePushSubscription, savePushSubscription, type DeviceSubscription } from "@/lib/push";
import { rememberTimezone } from "@/lib/orgs";
import { validTimezone } from "@/lib/schedules";
import { requireAppContext } from "@/lib/session";

export async function signOutAction() {
  await signOut();
}

/** The first browser to open the app tells us the company's timezone, for schedules. */
export async function rememberTimezoneAction(timezone: string) {
  const { organization } = await requireAppContext();
  if (!organization.timezone && validTimezone(timezone)) await rememberTimezone(organization.id, timezone);
}

/** Stops the Chief of Staff's reply in progress (it otherwise runs to the end, even with the panel closed). */
export async function stopChatAction(chatId: string) {
  const { organization, user } = await requireAppContext();
  await requestStop(chatId, organization.id, user.id);
}

/** This phone or browser gets push notifications for the signed-in person. */
export async function subscribePushAction(subscription: DeviceSubscription, userAgent: string) {
  const { organization, person } = await requireAppContext();
  try {
    await savePushSubscription(organization.id, person.id, subscription, userAgent);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't turn on notifications." };
  }
}

export async function unsubscribePushAction(endpoint: string) {
  const { person } = await requireAppContext();
  await removePushSubscription(person.id, endpoint);
}
