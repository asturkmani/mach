import "server-only";

import { createAgentUIStream, type LanguageModel, type UIMessage } from "ai";

import { forModel, restoreOriginals } from "@/lib/agents/chat-attachments";
import { conversationWindow, saveConversation } from "@/lib/agents/conversation";
import { generateMessageId, loadChiefOfStaff, replyText, type ChiefOfStaffContext } from "@/lib/agents/cos-turn";
import { prepareHistory } from "@/lib/agents/history";
import { appUrl } from "@/lib/app-url";
import { describeHours, keepAliveDue, localTime, isWorking } from "@/lib/assistant/hours";
import {
  claimDueWakeups,
  finishWakeups,
  getAssistantHours,
  keepAliveCandidates,
  postponeWakeups,
  recordNudge,
  scheduleWakeup,
  whatsAppWindow,
  type Wakeup,
} from "@/lib/assistant/store";
import { contextFor } from "@/lib/channels/senders";
import { sendWhatsApp, sendWhatsAppButtons, sendWhatsAppTemplate, templateValue, twilioConfigured, whatsappTemplateSid } from "@/lib/channels/twilio";
import { endReply, getOrCreateChat, takeTurn } from "@/lib/chats";
import { pushToPeople } from "@/lib/push";
import { getTask } from "@/lib/tasks";

// A person's assistant wakes up by itself (from the cron tick) when work of
// theirs is done or needs them, when it set itself a check-in, and to keep
// the WhatsApp conversation alive: WhatsApp lets a business write freely
// only within 24 hours of the person's last message. Each wake-up is a turn
// in their conversation that starts from a note only the assistant sees: it
// checks the work involved and either writes them one short message or
// stays quiet. Its words go out on WhatsApp while the window's open, in an
// approved template once it has closed (if one is set up), otherwise into
// the app's chat with a notification.

/** The reply that means "nothing worth sending". */
export const QUIET = "QUIET";
const HOUR = 3_600_000;

type Options = { model?: LanguageModel; research?: boolean; now?: Date };

/** One cron tick: keep-alives that are due, then every wake-up that's due, one turn per person. */
export async function runAssistantWakeups(options: Options = {}): Promise<number> {
  await scheduleKeepAlives(options.now ?? new Date());
  const groups = await claimDueWakeups();
  await Promise.all(groups.map((wakeups) => wake(wakeups, options)));
  return groups.length;
}

async function scheduleKeepAlives(now: Date): Promise<void> {
  if (!twilioConfigured()) return;
  for (const candidate of await keepAliveCandidates()) {
    const { timezone, hours } = await getAssistantHours(candidate.organizationId, candidate.personId);
    if (keepAliveDue(now, { ...candidate, timezone, hours })) {
      await scheduleWakeup(candidate.organizationId, candidate.personId, { reason: "keepalive", urgent: true, at: now });
    }
  }
}

async function wake(wakeups: Wakeup[], options: Options): Promise<void> {
  const ids = wakeups.map((w) => w.id);
  const { organizationId, personId } = wakeups[0];
  try {
    const context = await contextFor(organizationId, personId);
    if (!context) return await finishWakeups(ids);
    const { id } = await getOrCreateChat<UIMessage>(organizationId, context.user.id);
    // They're mid-conversation: it can wait a couple of minutes (and may well be dealt with by then).
    if (!(await takeTurn(id, { timeoutMs: 0 }))) return await postponeWakeups(ids, 2);
    try {
      await wakeTurn(context, wakeups, options);
    } finally {
      await endReply(id);
    }
    await finishWakeups(ids);
  } catch (error) {
    // Not retried: a turn that keeps failing would wake them every minute.
    console.error("The assistant's wake-up failed", error);
    await finishWakeups(ids);
  }
}

const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : `${Math.round(ms / HOUR)} hours`);

/**
 * The assistant's turn for these wake-ups: what it says (null when it stays
 * quiet), which has already been sent and saved in their conversation.
 */
export async function wakeTurn(context: ChiefOfStaffContext, wakeups: Wakeup[], options: Options = {}): Promise<string | null> {
  const now = options.now ?? new Date();
  const organizationId = context.organization.id;
  const person = context.person;
  const [{ timezone, hours }, window] = await Promise.all([
    getAssistantHours(organizationId, person.id),
    whatsAppWindow(organizationId, person.id),
  ]);
  const openFor = window.lastIn ? window.lastIn.getTime() + 24 * HOUR - now.getTime() : 0;
  const onWhatsApp = Boolean(person.whatsapp && twilioConfigured() && openFor > 60_000);
  // Once the window has closed, WhatsApp only takes an approved template, with the message as one line in it.
  const template = !onWhatsApp && person.whatsapp ? whatsappTemplateSid() : null;

  let proposing = false;
  const reasons = await Promise.all(
    wakeups.map(async (w) => {
      if (w.reason === "keepalive") return "keepalive";
      if (w.reason === "check_in") return `- You set yourself a check-in: ${w.note || "(no note)"}`;
      const task = w.taskId ? await getTask(organizationId, w.taskId, { viewer: person.id }) : null;
      if (!task) return "";
      if ((task.payload as { proposals?: boolean } | null)?.proposals && task.status === "review") {
        proposing = true;
        return `- Mach1 reviewed finished work and proposes changes, card #${task.number} (${appUrl(`/tasks/${task.number}`)}):\n${task.description}\nTell them each change in one plain numbered line, and ask whether to apply them ("yes", "just 2", "skip 1"). Don't apply anything here.`;
      }
      const state = task.status === "waiting" ? "needs their answer" : task.status === "review" ? "is ready for them to review" : `is now ${task.status}`;
      return `- Task #${task.number} "${task.title}" ${state} (${appUrl(`/tasks/${task.number}`)}).${w.note ? ` ${w.note}` : ""}`;
    }),
  );
  const keepAlive = reasons.includes("keepalive");
  const items = reasons.filter((r) => r && r !== "keepalive");
  if (!items.length && !keepAlive) return null;

  const local = localTime(now, timezone);
  const day = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][local.weekday - 1];
  const clock = `${String(Math.floor(local.minutes / 60)).padStart(2, "0")}:${String(local.minutes % 60).padStart(2, "0")}`;
  const note = [
    `[Not a message from ${person.name}. This is your own check-in, which they don't see: you woke up by yourself.]`,
    `For them it's ${day} ${clock} (${isWorking(now, timezone, hours) ? "working hours" : "outside working hours"}; their hours: ${describeHours(hours, timezone)}).`,
    window.lastIn
      ? `They last wrote to you on WhatsApp ${ago(now.getTime() - window.lastIn.getTime())} ago.${onWhatsApp ? ` You can write to them there freely for another ${ago(openFor)}; after that only by template, so a reply from them matters.` : ""}`
      : "",
    items.length ? `Why you woke:\n${items.join("\n")}` : "",
    items.length
      ? "Check each one first (read_task: what was done, what's being asked, and whether they've already seen to it or it has moved on). Tell them in a sentence or two what happened, with the link, and exactly what you need from them, if anything."
      : "",
    keepAlive
      ? `It's been quiet${items.length ? " otherwise too" : ""}, and the conversation goes cold if they don't reply within the window. Find something of theirs worth a reply, in this order: work they're waiting on (find_tasks and read_task: their open tasks and jobs, anything that moved or finished), something they asked about before and never followed up on (from the conversation and your notes), something you're still waiting on from them. If none of those exist, offer one concrete, useful thing you could do for them next, from their priorities, your notes on them and the company's goals. End with one clear question they can answer in a few words. No filler: never "just checking in". This message must go out: don't reply ${QUIET}.`
      : "",
    `Then reply with ONE short message to ${person.name}, which is sent as it stands ${
      onWhatsApp
        ? "on WhatsApp"
        : template
          ? "on WhatsApp inside a notice (their window has closed): one or two plain sentences, no line breaks, ending with what you'd like from them, so they reply"
          : "to their chat in Mach1, with a notification"
    }.${
      keepAlive ? "" : ` Or, if nothing here is worth their attention now (already handled, nothing new, nothing open), reply with exactly ${QUIET} and nothing else.`
    } Don't create tasks or post on tasks on your own here.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const chat = await getOrCreateChat<UIMessage>(organizationId, context.user.id);
  const { earlier, older, recent } = await conversationWindow(chat.id, chat.messages);
  const { agent, close } = await loadChiefOfStaff(context, { channel: onWhatsApp ? "whatsapp" : undefined, earlier, ...options });
  const history = await prepareHistory(recent, agent.tools);
  const prompt: UIMessage = { id: generateMessageId(), role: "user", parts: [{ type: "text", text: note }] };
  let finished: UIMessage[] = [];
  try {
    const shown = [...history, prompt];
    const stream = await createAgentUIStream({
      agent,
      uiMessages: await forModel(organizationId, shown),
      originalMessages: shown as never,
      generateMessageId,
      onEnd: async ({ messages }) => {
        finished = restoreOriginals(messages as UIMessage[], shown);
      },
    });
    for await (const chunk of stream) if (chunk.type === "error") throw new Error(chunk.errorText);
  } finally {
    await close();
  }
  const text = replyText(finished.slice(history.length + 1)).trim();
  if (!text || new RegExp(`^${QUIET}\\W*$`).test(text) || text.endsWith(QUIET)) return null;

  // Only its words are kept in the conversation: the check-in note and its digging stay out.
  const message: UIMessage = {
    id: generateMessageId(),
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { channel: onWhatsApp || template ? "whatsapp" : undefined, proactive: true },
  };
  // The conversation as it is now (the turn is held, so nothing else changed it).
  await saveConversation(chat.id, older, [...recent, message]);
  // Proposed changes can be answered with a tap: Apply all, Choose (they say which), or Skip.
  if (onWhatsApp && proposing) await sendWhatsAppButtons(`+${person.whatsapp}`, text, ["Apply all", "Choose", "Skip"], "Apply these changes?");
  else if (onWhatsApp) await sendWhatsApp(`+${person.whatsapp}`, text);
  else if (template) {
    await sendWhatsAppTemplate(`+${person.whatsapp}`, template, { "1": person.name.split(" ")[0] || person.name, "2": templateValue(text) });
  } else {
    await pushToPeople(organizationId, [person.id], { title: "Chief of Staff", body: text.slice(0, 180), url: "/", tag: "assistant" });
  }
  await recordNudge(organizationId, person.id);
  return text;
}
