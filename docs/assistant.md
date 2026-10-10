# The assistant writes first

Each person's Chief of Staff is also their own assistant, and it doesn't only answer: it wakes up by itself
and messages them when there's something worth their attention.

## When it wakes

| Why | When | Where it comes from |
| --- | --- | --- |
| Work of theirs is ready to review | In their working hours | A task they're on or asked for moves to review (`notifyNeeded` in `lib/tasks.ts`) |
| Work of theirs needs their answer | Straight away, unless it's their quiet hours | A task moves to waiting |
| A check-in it set itself | When it asked, moved out of quiet hours | The `check_back_later` tool ("I'll check on the import at 4") |
| Keep-alive | The start or end of their working day, else just before the window closes | WhatsApp's window would otherwise close (below) |

Task wake-ups are only for people who reach their assistant on WhatsApp; everyone gets the push notification.

Each wake-up is a turn in the person's conversation (one at a time, like any reply) that starts from a note
only the assistant sees: why it woke, their local time and hours, how long since they last wrote. It checks
the work involved (`read_task`, `find_tasks`) and replies with one short message, or exactly `QUIET` when
there's nothing worth saying. Only the message is kept in the conversation. It goes out on WhatsApp while
the window is open. Once it has closed, nothing more goes to WhatsApp until they write (an approved
template could, docs/channels.md, but none is set): it goes into the app's chat with a push notification. If they're mid-conversation it
waits two minutes.

## Their hours

Timezone, working days and hours, and quiet hours (`people.timezone`, `people.work_hours`). Until they set
them, the company's timezone and Mon–Fri 09:00–18:00, quiet 21:00–08:00 stand in. The assistant asks once
(at the end of onboarding, or early on for people who join later) and saves the answer with `save_my_hours`;
people can change them in Settings → Account → Your hours.

## How it looks on WhatsApp

When a message arrives, the assistant marks it read (blue ticks) and shows "typing…" until it replies
(`showTyping` in `lib/channels/twilio.ts`, renewed every 20 seconds). Twilio can't send emoji reactions.

For anything that takes more than a moment (several tools, research, browsing, a task or an agent, coding),
it first writes one line saying it's on it, then works. On WhatsApp and email, words written before a tool
call go out straight away as that acknowledgement (`acknowledge` in `lib/agents/cos-turn.ts`), "typing…"
comes back while it works, and the answer follows. Quick questions get the answer, with no acknowledgement.

## WhatsApp's 24 hours

WhatsApp lets a business write freely only within 24 hours of the person's last message; after that, only
approved templates. So the assistant tries not to let the window close: when it's been quiet, at the start
or end of their working day (when people reply), it writes something worth answering, in this order:

1. work they're waiting on (theirs, moved or finished);
2. something they asked about and never followed up;
3. something it's still waiting on from them;

ending with a question they can answer in a few words; with none of those, one concrete thing it could do
for them next. Never "just checking in", and a keep-alive is never skipped. It goes out once 12 hours
have passed, or earlier at the last start or end of a working day before the window closes (a Friday
afternoon before the weekend). When no working day starts or ends before it closes (they wrote late on a
Friday), it goes in the last three hours before it does, outside quiet hours. Only once per message from
them (`keepAliveDue` in
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

## Big jobs: the coordinator

Before a big job (several steps or agents, several deliverables, days of work), the Chief of Staff calls
`plan_job` (`lib/agents/planner.ts`): the company's planner model (Opus 5.5 at high, or GPT-6 Astra;
`lib/ai/lineup.ts`) writes what to ask first, the steps, who does each (a defined agent or a new worker)
and which need which, from the profile, agents, data sources, files and open tasks. The Chief of Staff asks
the questions, or creates each step with `create_task`, later ones with `after` (the task numbers they
need). A task that waits stays in backlog (`tasks.waits_for`) and starts by itself once everything it
waits for is delivered, in review or done (`startFollowers` in `lib/agents/dispatch.ts`, run when a
status changes and when an agent's run ends).

## Everything from chat

The Chief of Staff can do what the person it's talking to can do on Mach1's screens, with their permissions.
It knows who on the team has joined, been invited, or is an admin.

**Actions are declared once.** Everything a screen does is an action in `lib/actions` (`tasks.ts`,
`company.ts`, `research.ts`): a name like `task.set_status`, one line saying what it does, its inputs (zod) and, for
admin-only ones, `who: "admin"`. The screens' server actions call `performAs(actor, name, input)`; the Chief
of Staff gets the catalogue (every action the person may do, one line each) in its instructions and performs
any of them with one tool, `do_action` (`lib/agents/action-tools.ts`). Inputs take ids from screens and names
from chat (a task's number, a person's or agent's exact name, a file's name). Finer rules (whose task, file or
page it is) live in `lib/operations.ts`, so chat can never do more than the person could in the app.

**Adding something to a screen**: declare it in `lib/actions` and call `performAs` from the server action;
chat has it from then on. `lib/actions/coverage.test.ts` reads every `app/**/actions.ts` and fails for a
server action that doesn't go through the registry (or an operation a registered action uses), isn't one of
the Chief of Staff's own tools (`create_task`, `reply_on_task`, …), and isn't listed as screen-only with the
reason. Never through chat, whoever asks: credentials and keys, deleting the company, linking WhatsApp. For
those it sends the exact link.

**Links**: every page starts with a `// @map Title | Where in the menus | What's there` line. `npm run build`
(and `vercel-build`) writes them to `lib/app-map.json` (`scripts/app-map.mjs`), which the Chief of Staff reads
to give the exact link and where it is, never just the home page. A test fails when a page has no `@map` line
or the file is out of date (`npm run app-map` updates it).
