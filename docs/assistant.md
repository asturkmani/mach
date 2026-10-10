# The assistant writes first

Each person's Chief of Staff is also their own assistant, and it doesn't only answer: it wakes up by itself
and messages them when there's something worth their attention.

## When it wakes

| Why | When | Where it comes from |
| --- | --- | --- |
| Work of theirs is ready to review | In their working hours | A task they're on or asked for moves to review (`notifyNeeded` in `lib/tasks.ts`) |
| Work of theirs needs their answer | Straight away, unless it's their quiet hours | A task moves to waiting |
| A check-in it set itself | When it asked, moved out of quiet hours | The `check_back_later` tool ("I'll check on the import at 4") |
| Keep-alive | The start or end of their working day | WhatsApp's window would otherwise close (below) |

Task wake-ups are only for people who reach their assistant on WhatsApp; everyone gets the push notification.

Each wake-up is a turn in the person's conversation (one at a time, like any reply) that starts from a note
only the assistant sees: why it woke, their local time and hours, how long since they last wrote. It checks
the work involved (`read_task`, `find_tasks`) and replies with one short message, or exactly `QUIET` when
there's nothing worth saying. Only the message is kept in the conversation. It goes out on WhatsApp while
the window is open, otherwise into the app's chat with a push notification. If they're mid-conversation it
waits two minutes.

## Their hours

Timezone, working days and hours, and quiet hours (`people.timezone`, `people.work_hours`). Until they set
them, the company's timezone and Mon–Fri 09:00–18:00, quiet 21:00–08:00 stand in. The assistant asks once
(at the end of onboarding, or early on for people who join later) and saves the answer with `save_my_hours`;
people can change them in Settings → Account → Your hours.

## WhatsApp's 24 hours

WhatsApp lets a business write freely only within 24 hours of the person's last message; after that, only
approved templates. So the assistant tries not to let the window close: when it's been quiet, at the start
or end of their working day (when people reply), it writes something worth answering, in this order:

1. work they're waiting on (theirs, moved or finished);
2. something they asked about and never followed up;
3. something it's still waiting on from them;

ending with a question they can answer in a few words. Never "just checking in". It goes out once 12 hours
have passed, or earlier at the last start or end of a working day before the window closes (a Friday
afternoon before the weekend), and only once per message from them (`keepAliveDue` in
`lib/assistant/hours.ts`).

## Asking a specialist

The Chief of Staff runs on a fast, cheaper model and hands expertise to the company's defined agents, each
on a model chosen for its work (Team → the agent → Model; defaults in `.env.example`). For a question,
`ask_specialist` runs the agent on the spot (its instructions, the data sources it may use, research and the
person's sandbox) and waits up to three minutes. If the agent says the question needs real work, or runs
out of time, it becomes a task for that agent instead, which reports back (and wakes the assistant when
it's done). Jobs still go to tasks directly (`create_task`, `start_coding`).

## Code

| File | |
| --- | --- |
| `lib/assistant/hours.ts` | Working and quiet hours, when something may be delivered, when a keep-alive is due |
| `lib/assistant/store.ts` | Hours, the WhatsApp window, and the `assistant_wakeups` queue |
| `lib/assistant/wake.ts` | The wake-up turn, run from the cron tick (`app/api/cron/tick`) every minute |
| `lib/agents/specialist.ts` | `ask_specialist`: a defined agent answering a question while the Chief of Staff waits |
