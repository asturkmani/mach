import "server-only";

import { appUrl } from "@/lib/app-url";
import { sendWhatsApp, twilioConfigured } from "@/lib/channels/twilio";
import { getOrCreateChat, saveChat } from "@/lib/chats";
import { getDb } from "@/lib/db";

// Work asked for over WhatsApp reports back there: when the task is ready for
// review or needs an answer, whoever asked gets its agent's latest word on
// WhatsApp, with the link. It also goes into their Chief of Staff chat (the
// same conversation), so a reply like "merge it" reaches the right task.

type TaskForReply = { id: string; number: number; title: string; status: string; summary: string; createdByPersonId: string | null };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export async function tellOnWhatsApp(organizationId: string, task: TaskForReply): Promise<void> {
  if (!twilioConfigured() || !task.createdByPersonId) return;
  try {
    const db = getDb();
    const [person] = await db.query<{ whatsapp: string | null; workos_user_id: string | null }>(
      "select whatsapp, workos_user_id from people where organization_id = $1 and id = $2",
      [organizationId, task.createdByPersonId],
    );
    if (!person?.whatsapp) return;
    const [latest] = await db.query<{ author: string; body: string }>(
      `select author, body from task_messages where task_id = $1 and agent_id is not null and kind in ('result', 'ask', 'update')
       order by created_at desc limit 1`,
      [task.id],
    );
    const what = task.status === "review" ? "is done" : "needs your answer";
    const body = latest?.body?.trim() || task.summary || "";
    const text = [`#${task.number} ${task.title} ${what}.`, body && clip(body, 1500), `Reply here, or open ${appUrl(`/tasks/${task.number}`)}`]
      .filter(Boolean)
      .join("\n\n");
    await sendWhatsApp(`+${person.whatsapp}`, text);
    if (person.workos_user_id) {
      const chat = await getOrCreateChat(organizationId, person.workos_user_id);
      await saveChat(chat.id, [
        ...chat.messages,
        {
          id: `msg-task-${task.id}-${Date.now()}`,
          role: "assistant",
          parts: [{ type: "text", text: `${text}\n\n(Sent on WhatsApp about task #${task.number}.)` }],
          metadata: { channel: "whatsapp", taskNumber: task.number },
        },
      ]);
    }
  } catch (error) {
    // Outside WhatsApp's 24-hour window Twilio refuses free text; the push notification and Home still show it.
    console.error("Couldn't report a task on WhatsApp", (error as Error).message);
  }
}
