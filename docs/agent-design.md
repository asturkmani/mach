# Agents, skills and connections

**Status: proposed 2026-10-10.** Not built yet. Once built, it replaces:
- "Asking a specialist" and "Big jobs: the coordinator" in [assistant.md](assistant.md);
- the Developer and the Researcher as agents ([github.md](github.md), [research.md](research.md));
- the agents a company defines, and the worker agent made for each task;
- limits on which agents may use an integration ([integrations.md](integrations.md)).

## The idea

Mach1 is split into three parts:

- **A fixed runtime of four agents**, which nobody configures: the chat agent, the coordinator, the worker and the browser agent.
- **Skills and scripts**, which are what grows. A few base skills ship with Mach1. Everything else is learned on the job: the first time, a worker works something out. After that, it's a skill (how to do it) and scripts (the parts that run without a model).
- **Connections**: the company's APIs and website logins. Credentials are sealed. Every agent in the company can use them, within the limits an admin sets for whose work they serve.

Work moves from the model into skill text, and from skill text into scripts. Each step makes it cheaper and more reliable, and every company's Mach1 gets better at that company's work.

Learning happens after the work, never during it:
1. A decision model (Jev) looks at each finished worker task or job and decides whether there's anything to learn.
2. Only if it says yes, a learner (the planner model) reads the whole run and decides whether to update a skill or write a new one.

## Why

- **Today's role agents are already one agent.** Every task agent runs the same loop (`runAgentOnTask`) with the same tools.
  - The Developer's instructions are one line: "Load the coding-in-github skill before you start, and follow it."
  - The Researcher's are the same line with the research skill, plus two extra tools, `exa_search` and `investigate`.
  - A worker agent is just a role name made for one task.
  - `coder` and `worker` are the same model in both lineups.
- **Big jobs have no owner.** `plan_job` writes a plan as text, the cheapest model turns it into tasks with `after`, and `startFollowers` starts them in order. Nothing checks the parts or puts them together, and each task reports to people separately.
- **Long work runs in the chat turn.** The Chief of Staff runs code, the browser and page building inside a request that can last 800 s and doesn't survive a failure.
- **What's learned is scattered.** Scripts are saved in the file library but stay attached to their task, so nothing finds them for new work. Know-how sits in integration guides, a job's `NOTES.md` and the defined agents' instructions.
- **It's where the field has landed.** In Claude's Agent SDK and Claude Code ([subagents](https://code.claude.com/docs/en/sub-agents)), every worker is the same kind of session. Subagents exist only to keep verbose work out of the main context, to restrict tools, or to run work in parallel. Reusable know-how is a skill: a `SKILL.md` with its scripts ([Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). [Claude Code Projects](https://code.claude.com/docs/en/claude-projects) (beta) has one coordinator that starts generic threads and sees only what they report. Instinct, from what it has said in public, is one generalist agent with checks around it that aren't agents.

## The six scenarios

Every part of this design is there for at least one of these. They are also the acceptance tests (below).

| # | Request | Route | Why |
|---|---|---|---|
| 1 | "What tasks are still open?" | Chat agent, no tool | The open tasks are already in its context |
| 2 | "Invite Y, here's their email and number" | Chat agent, `do_action` | `person.add` with `invite` |
| 3 | "Pull last night's open issues, fix them and test" | Job | How many workers it needs depends on what it finds |
| 4 | "Coverage of all memory stocks, a model each with bull/base/bear, a deck of 2027E EPS" | Job | Parallel work that must share assumptions, then one deck |
| 5 | "Monthly: Kalshi numbers from XYZ.com with charts; separately, regulatory status by state from ZZZ.com" | Two workers, each repeating | Two independent deliverables |
| 6 | "Weekly: untagged Masttro transactions, Rita for Hassan Daher's, Mawla for Wissam Daher's, auto-tag clear repeats, else Mustapha; I confirm; then tag them in Masttro's web app" | Job, repeating | A process with people, an approval, and writes to another system |

## The runtime

```
                          ┌──────────────┐
  panel · WhatsApp · email│  Chat agent  │  chat model, in the turn, one per person
                          └──┬────────┬──┘
           spawn_worker      │        │      start_job
                 ┌───────────┘        └────────────┐
                 ▼                                 ▼
          ┌────────────┐                    ┌──────────────┐
          │   Worker   │◀── start_child ────│ Coordinator  │  planner model, on the job's task
          │  + skills  │                    └──────┬───────┘
          └─────┬──────┘                           │ start_child
     use_browser│                                  ▼
                ▼                           a person, or a script
          browser agent
```

There are four agents, and only four. No company defines its own, and no task gets an agent made for it.

Two background steps run after the work, and neither is an agent anyone talks to: the **gate** (Jev) and the **learner**. See Learning on the job.

### Chat agent

One per person per company, as today: the same conversation from the panel, WhatsApp and email, one turn at a time, on the `chat` model.

**It does these itself, in the turn:**
- Answers from what it already has: the profile, open tasks, files, pages and the team.
- Does actions with `do_action`, with the person's permissions.
- Quick lookups: `web_search`, `fetch_page`, `market_data`, `x_search`, `reddit_search`, `find_tasks`, `read_task`, or a GET with `call_api`.
- Sets up connections, since the credentials card and the sign-in code card live in the chat.
- Onboarding and profile suggestions.

**It hands everything else off by these rules:**
1. If the context or one quick tool covers it, answer.
2. If it's one thing to change in the app, use `do_action`.
3. If it's one deliverable and one kind of work, use `spawn_worker`. If the answer is likely within a few minutes, pass `wait` and answer in the chat. If it takes longer, it becomes a task that reports back.
4. Use `start_job` for any of these:
   - several deliverables that depend on each other;
   - a process with people or an approval in it;
   - in-depth research;
   - work whose shape nobody can know until someone looks.
5. If unsure between 3 and 4, use a worker. It can escalate.

**It writes the brief**, since workers don't see the chat: the request, with everything from the conversation the work needs. It also says which skills to pin and who the work is for.

### Worker

One built-in agent per company, called **Worker**. It works on a task in the agent-run workflow exactly as task agents do today: the same lease, the same turn limits, the same durable steps (`lib/agents/runner.ts`).

- **Skills.** The skills pinned to the task are loaded before it starts, and their scripts are copied into the sandbox. It can load more at any point with `use_skill`.
- **Connections.** It may use every connection of the company that the person it works for may use. Anything it would change outside Mach1 still needs an approval (see Gates in code).
- **Model.** The model set on the task when it was started, else the default of the first pinned skill, else the company's model for agents, else the `worker` role.
- **Ending a run.** `finish` or `ask`, as today. On a job's child task, these go to the coordinator first.
- **Escalating.** When the work needs a plan or needs to go wide (it found eight issues, not one, or the question splits into six), it calls `escalate`. Its task becomes a job, a coordinator takes over, and what the worker found becomes the coordinator's first input. A worker never starts another agent itself.
- **Long runs.** Before each model call, older tool results (search hits, whole pages, command output) are trimmed to a short note of what they held. A run that reads a lot keeps a working context without needing a second agent.
- **Learning.** None, during the run. It doesn't write or change skills. What it did is reviewed after the round closes (see Learning on the job).

`hand_off` goes: with one kind of worker there's no one to hand off to. Splitting work is the coordinator's job.

### Coordinator

The agent of a **job**: a task with child tasks. It runs on the job's own task in the agent-run workflow, on the `planner` model (Opus 5.5, or GPT-6 Astra), and replaces `plan_job`.

**Its turns are short**, and each one is an ordinary run:

1. **First run.**
   - Settles what has to be asked first. The person answers on the job's task, through `ask`.
   - Writes the plan into the job's thread.
   - Shows a cost estimate when it's over the company's limit, and waits for the person to approve.
   - Starts the children that can start now.
   - Ends.
2. **Later runs.** Children started together form a batch.
   - It wakes once when the whole batch has delivered, not once per child, because every turn it takes is on the planner model.
   - It also wakes as soon as a child asks something or fails, or a person writes on the job.
   - In each run it reviews what came back, answers a child or sends it back with a reply, starts the next children, or asks the person.
3. **Last run.** Puts the result together (a file, a deck, a table) and reports with `finish`. This is the only report the person gets.

**Each child task has one assignee:**

| Assignee | What it is | Example |
|---|---|---|
| Worker | A task for the Worker, with pinned skills | Fix issue #412; model SK hynix |
| Person | A task with only that person on it: a question, or a list to go through. Their own assistant tells them, and their answer comes back on the task | Rita: tag these 14 transactions |
| Script | A task that runs a skill's script without a model. If the script fails, a worker is woken to fix it | Pull untagged transactions from Masttro |

**Rules for children:**
- **Who they're for.** Children are created for the person the job is for, never "by the coordinator". Whose accounts a run may use (their GitHub, the connections they may use) depends on who it's for (`workingForId`).
- **Who hears about them.** A worker child's `ask` and `finish` wake the coordinator, not people. The coordinator either answers or asks the person. People can still open a child and write on it directly. A person child does notify its person, since that's its purpose.
- **Order.** `after` works as today: a child waits in backlog until the children it needs have delivered.
- **Depth.** Children can't start jobs. A worker child that needs a plan tells the coordinator, which re-plans.
- **Limits.**
  - At most 8 children run at once, and 40 per job.
  - The coordinator's messages don't reset a child's count of agent turns, so the six-turn limit still stops a loop between them.

**In-depth research is a job:**
1. The coordinator frames the question with the `research` skill: the decision it serves, and what a good answer contains. It splits the question into three to six parts.
2. It starts one worker child per part, as one batch. Each child loads `research`, investigates, and finishes with compressed findings: dated, marked as fact, estimate or opinion, with numbered sources. It doesn't hand over everything it read, so the coordinator's context stays small.
3. The coordinator reads the batch, runs a second round for the gaps that matter (two rounds at most), then writes the brief.

A quick research question ("what's the market saying about Micron's guidance?") goes to one worker with `wait` and is answered in the chat. This replaces the Researcher's sub-researchers (`investigate`).

**Repeating jobs.** A job can have a schedule.
- The first good run saves its plan as a company skill: a **workflow skill**, with the scripts the run used.
- Later runs load that skill and don't plan again unless something fails.
- If the previous run's children are still open when the next run is due, the coordinator carries the open items into the new run instead of skipping it.

### Browser agent

`use_browser` hands one bounded job on a website to the browser agent. It stays a separate agent, unchanged, for four reasons:
- It runs on its own vision model.
- A screenshot after every step would swamp the caller's context.
- Web pages are untrusted, so the caller should only read the browser agent's report.
- Its sessions carry on between calls.

How to use it well is a base skill, `using-the-browser`. A website workflow that gets repeated becomes a Playwright script inside a skill and runs without it.

### What the runtime guarantees, and skills can't

A skill is text the model reads, so it can only ask for things. These have to hold even when the model ignores its instructions, so they live in code:

- **Durability.** Long jobs survive failures and outlast a function's time limit (Vercel Workflow).
- **One run at a time per task** (the lease), and the six-turn limit.
- **Waiting for people.** Person children, wake-ups, and quiet hours.
- **Who may use a connection.** Credentials stay sealed and out of models and sandboxes.
- **Approvals** before changes outside Mach1, and cost approvals.

## Skills and scripts

### What a skill is

A folder in the [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) layout, so Mach1 and Claude Code can each read the other's skills:

| Part | |
|---|---|
| `SKILL.md`: name and description | What it's called, and when to use it, in one line. This is all the catalogue shows |
| `SKILL.md`: body | How to do the work: the steps, the judgment calls, who to ask, what needs approval, what good looks like |
| `scripts/` | The parts that run without a model, e.g. `pull_untagged.py` or `tag_cmr.py`. Copied into the sandbox when the skill is loaded |
| `scripts/test` | An example run each script must pass before the skill is saved or changed |
| Front matter | Connections its scripts use; a default model and effort; tools it switches on (from a fixed list, e.g. `exa_search`); `extends` (below) |

A skill never contains credentials, and never grants itself access to anything. Scripts call connections through the sandbox's network proxy, which adds credentials on the way out, as today.

**Two kinds, by what they describe:**
- **System skills** cover how one system behaves: its endpoints, paging, quirks, the clicks through its web app, and scripts to pull from it. There's one per connection, made when the connection is made. Today's integration guides become these.
- **Workflow skills** cover how this company does a piece of work: the steps, who gets what, the rules, the approvals, and the scripts that carry it out. "Masttro weekly tagging" and "how we do month-end" are workflow skills.

### Decisions inside skills

Most repeated work is a loop of small decisions: which tag, which entity, is this a repeat, who should look at it. A skill's scripts make each one with the right tool:

| The decision | Made by | Examples |
|---|---|---|
| Arithmetic, dates, exact lookups | Code, in the script | Amount within 2% of the last three payments; monthly, last paid 3 Sept; counterparty seen before |
| Policy: who gets what, thresholds, what needs approval | Rules written in the skill, run by code | Hassan Daher's entities go to Rita; auto-tag only above the threshold |
| A judgment with a known set of answers | Jev, called from the script | Which tag; which entity a counterparty belongs to; whether this repeats an earlier transaction |
| Anything that needs reasoning, writing or several steps | The worker's model | Explaining an odd transaction; drafting the note to Mustapha |

Jev never compares numbers or dates itself, because that's where it's documented to be weak. Code turns them into plain facts in the state ("amount matches the last three payments", "monthly, last on 3 Sept"), and Jev judges from those.

**Calling Jev from a script.** The sandbox template gets a small helper, `mach.decide` (a Python module and a CLI). A script passes it a state and its questions, and gets back the choice and its probabilities.
- The request goes to AI Gateway, with the key added by the network proxy, so the key never enters the sandbox.
- The proxy allows only the Jev model, within a budget per run.

**Options come from the source each run.** They're never written into the script.
- The tag list is fetched from Masttro, and the entity list from the skill.
- Jev's Choice takes up to 255 options. With more, code narrows them first to the likely candidates: this counterparty's past tags, then the nearest past cases.
- There's always a "none of these" option.

**History goes into the state.** Every decision a skill's scripts make is kept in its decision history:
- the state;
- the options;
- Jev's probabilities;
- the threshold at the time;
- what happened: applied automatically, confirmed by a person, or changed to something else.

For a new decision, code puts the closest past cases with their final answers into the state, up to ten of them: the same counterparty first, then the nearest descriptions. That's how Jev "knows" that payments to this counterparty are tagged Rent, Hassan Daher Holdings. Nothing is trained. The history is part of each question, so a correction made last week counts this week.

**Thresholds come from the history.** A skill says how often an automatic answer must be right, e.g. "98%".
- On every run, code backtests against the past answers people confirmed or changed. It picks the lowest threshold at which Jev's automatic answers would have been right at least that often.
- If there isn't enough history yet, or no threshold reaches the target, nothing is applied automatically. Everything goes to people, with Jev's suggestion filled in.
- "98% confident" therefore means measured on this company's own past answers, not a number a model states about itself.

**People confirm suggestions; they don't start from blank.** A person's list shows Jev's suggestion and how sure it is. Confirming or changing it adds to the history. When people keep changing the same kind of answer, the learner proposes a fix to the skill, such as a new entity or a new rule. Those are policy changes, so they go to the owner.

### Base skills and company skills

| | Base skills | Company skills |
|---|---|---|
| **Who writes them** | Mach1's developers | Learned on the job, or written by people |
| **Where they live** | The repo: `skills/<name>/`, collected at build time like `lib/app-map.json` | Postgres (`skills`, `skill_versions`). Scripts are versioned files in the file library |
| **Who sees them** | Every company | The company. Private ones only their owner, with the same rules as tasks |
| **How they change** | With a deploy | A new version each time, applied by a person (system skills: by agents, see below) |
| **Names** | Plain: `research` | Can't reuse a base skill's name |

**Extending, not forking.** A company never edits a base skill. To add its own way of doing something ("our decks use this template and these colours", "our models use our chart of accounts"), it writes a company skill that `extends` the base one. That skill is loaded straight after it. Base skills keep getting fixes, and company details survive them.

**Moving a skill up to base.** When the same kind of company skill shows up across many companies (several have learned to work with the same platform), Mach1's developers can write a general base skill from the pattern. This is never automatic, and nothing company-specific is copied: no names, rules or data. Company skills are never shared between companies.

**The catalogue.** Every agent's instructions list the base skills and the company skills the person can see, one line each. The body is read only when a skill is loaded. Once a company has more than about 40 skills, the list becomes a search (`find_skill`), so the prompt stays small.

### Base skills

| Skill | For | Status |
|---|---|---|
| `company-profile` | Writing the profile | Today |
| `writing-tasks` | Briefs for `spawn_worker` and `start_job`: titles, who's on it, which skills to pin | Today, changed |
| `research` | Framing a question for the decision it serves, investigating one part well, the findings format children report in, writing the brief | Today; switches on `exa_search`. Going wide is a job |
| `financial-analysis` | Statements, valuation, scenarios | Today |
| `excel-models` | Models with working formulas, recalculated | Today |
| `connecting-integrations` | Setting up a connection and writing its first system skill | Today, changed |
| `building-pages` | Pages and their refresh jobs | Today |
| `coding-in-github` | Branch, change, test, PR, as the person; default model `coder` | Today |
| `coordinating` | The coordinator's playbook: asking first, plan shape, batches, children, review, assembly, gates | New |
| `presentations` | Decks with `python-pptx` from a model's numbers | New (scenario 4) |
| `data-pipelines` | Pulling a site or API into scripts: history on the drive, diffs against last time, charts, a `SUMMARY:` line | New (scenario 5) |
| `reconciliation` | Classifying items against history with `mach.decide`, numbers as facts from code, thresholds from backtests, the rest to people with suggestions, keeping a ledger | New (scenario 6) |
| `issue-triage` | Finding, deduplicating and reproducing issues before fixing them | New (scenario 3) |
| `using-the-browser` | When to use the browser agent, how to brief it, what needs approval first | New |
| `writing-skills` | Turning what a job learned into a skill and scripts, with tests | New |

`designing-agents` goes, since companies no longer define agents.

**When Mach1 adds a base skill:** all three of these must hold.
- The kind of work recurs across companies.
- Agents get it wrong, or work slowly, without guidance. Run them on representative requests first and look.
- It isn't one company's way of working (that's a company skill), and it isn't one system's behaviour (that's a system skill).

Each new base skill ships with a scenario in this document's style, checked before release.

### Learning on the job

Over time, a piece of work goes through this loop:

1. **First time.** A worker figures the work out: the browser, `call_api`, code.
2. **After the round closes**, the gate decides whether there was anything to learn. If yes, the learner writes a new skill (the steps, plus the scripts the worker wrote) or updates one.
3. **Next time**, the chat agent or coordinator pins the skill. The worker runs its scripts, and the model only handles exceptions.
4. **When a script breaks** (the site changed), the worker fixes it to finish the job. The gate notices, and the learner saves the fixed script into the skill.

The worker and the coordinator never write skills themselves. They're deep in the task and grading their own work, and they may have read a page or an email that tells them to "remember" something. A separate review of the run, with fresh context, is the check.

#### When the review runs

The review runs once per round, when the round closes: when a person replies on the result or marks it done, or when a repeating run reports. Waiting for that moment means the review sees people's corrections.
- **A standalone worker task** gets one review per round.
- **A job** gets one review, after the coordinator's report, covering the coordinator and all its children. Children aren't reviewed on their own. The learner needs the whole job to see what's worth keeping.

The review runs in the background, after the report has gone out, so it never delays anyone.

#### The digest

Code builds a compact digest of the run from what Mach1 records:
- the request, and the skills that were pinned or loaded;
- the steps, from the run log: tools called, scripts run with their exit codes, and scripts written or rewritten;
- what people wrote on the task, and the options they picked;
- how it ended, including the proposed and approved versions of any approval;
- the deliverables, by name.

It leaves out raw web pages and API responses. They're long, they're the untrusted part, and Jev handles large, noisy input badly. A digest stays under 24k tokens. For a big job, each child is summarised in a few lines.

#### Stage 1: the gate (Jev)

[Jev](https://www.infoq.com/news/2026/10/typesafe-ai-jev-released/) is TypeSafe AI's decision model. It returns typed probabilities instead of text, answers several questions in one pass in well under a second, and costs $0.042 per million input tokens. It's on Vercel AI Gateway, so Mach1 calls it through the gateway with no new vendor or key.

One call per review, with the digest as the state and these questions:

| Question | Type |
|---|---|
| What, if anything, should be learned? Nothing / update a system skill / update a workflow skill / a new skill | Choice |
| A person corrected how the work was done | Noul (yes or no) |
| The run departed from the skill it was given | Noul |
| A script was written or rewritten and worked | Noul |
| This work will be asked for again | Noul |

**The learner runs** if "nothing" is below its threshold, or any yes is above its threshold. The thresholds are set to catch more rather than less:
- A false yes costs one learner run that decides there's nothing to change.
- A false no means the lesson is learned the next time it comes up.

Jev gives no reasons, and doesn't need to here: the learner reads the run and writes its own.

**Reliability.** The model version is pinned (e.g. `jev-1.13.0`). If Jev is down or errors, the same questions go to the `background` model (Haiku 5.5 or GPT-6 Luna), answered as probabilities.

**Tuning.** Every learner run labels the gate's decision for free: the learner either changed something or found nothing. These labels go in `learning_reviews` and become the eval set for setting thresholds. Running that set costs cents.

#### Stage 2: the learner

A new `learner` role in the lineup (`lib/ai/lineup.ts`), set to the planner model for now: Opus 5.5, or GPT-6 Astra. Learned skills compound, so this isn't the place to save on the model.

**It reads** the full run: the thread, the skills and scripts that were used, what changed in the scripts, test results, `NOTES.md`, and where the run left the skill. It also sees the gate's answers, and the proposals the skill's owner has declined before.

**It decides** one or more of: nothing; update a system skill; update a workflow skill; save or fix a script; or write a new skill. Every line it adds or changes has to cite something that happened in the run: a message, a step, or a script result.

**It works** in the job's sandbox, which is resumed if needed, so it can run a script's test before saving the script.

#### Checks, and who applies a change

Code checks every change the learner drafts:
- **Tests.** Scripts pass their test.
- **Secrets.** No known secret values.
- **Citations.** Every changed line cites a step or message from the run.
- **Where the text came from.** Nothing in a workflow skill comes from external text (a page, an email, an API response) unless a person's message on the task backs it.

Code then classifies the change by which parts of the skill it touches. The learner doesn't classify its own change.

| Change | Applied by |
|---|---|
| A system skill (how a system behaves) | Automatically. A new version, with the task it came from, which can be rolled back |
| A workflow skill, refinement only: clearer steps, an example, a fixed script that passes its test | Automatically. It's listed in the owner's weekly digest from their Chief of Staff, and "undo" rolls it back |
| A workflow skill, policy: who is asked or told, what is written outside Mach1, approvals, thresholds, connections, pre-approvals, which means anything in the front matter or the People, Rules or Approvals sections | The skill's owner, asked by their Chief of Staff |
| A new workflow skill | Its owner, once. Later changes follow the rows above |

**Asking the owner.** It works like any wake-up: in their working hours, on WhatsApp when the window is open, and also as a suggestion card in Needs you. The card shows the change and the line from the run behind it. For example: "Last week Rita said the Daher Family Trust is hers too. Add that to Masttro tagging?" A yes applies it. A no is recorded, so the learner doesn't propose it again. For a company-wide skill, the owner or an admin decides.

Skills can also be written from chat: "here's how we do month-end, save it". The chat agent drafts the skill with `propose_skill` and shows the card.

### Where knowledge goes

There is one home for each kind:

| Knowledge | Where | Who changes it |
|---|---|---|
| What the company is and wants, and rules for everyone ("ask before contacting anyone outside the company") | Company profile | A person applies a suggestion |
| About one person | Their personal notes | Their assistant, and them |
| One job's state: parameters, results, decisions | The job's `NOTES.md` | The job's agents |
| How a system behaves | A system skill | The learner, applied automatically, with versions |
| How the company does a piece of work | A workflow skill | The learner: refinements applied automatically, policy and new skills by a person |
| The parts that run without a model | Scripts in a skill | With the skill, and a passing test |

## Connections

A connection is a data source (an API) or a website login, as integrations are today:
- **Credentials** are sealed with `MACH_SECRETS_KEY`. They never reach a model, a chat or a sandbox.
- **Requests are signed** on the server (`call_api`), or by the sandbox's network proxy for scripts.
- **A data source can be read-only.** Then it refuses anything but GET.

**Who may use one.** Every agent in the company. An admin can limit a connection to chosen people: then it's used only for their work, meaning their assistant and runs that work for them. Limits by agent go (the `agent_ids` column, and the agent picker in Settings → Integrations).

**What stops misuse** without limits by agent:
- read-only data sources;
- approvals in code before any change outside Mach1;
- credentials that nothing in Mach1 can read back.

**Each connection has a system skill**, made when it's connected and improved by the learner after jobs that use it. Today's guide becomes that skill's body.

## Tools

Who gets what: ● always, ○ when a skill switches it on, – never.

| Tool | Chat agent | Worker | Coordinator |
|---|---|---|---|
| `do_action` | ● | – | – |
| `find_tasks`, `read_task` | ● | – | ● (its children) |
| `reply_on_task`, `check_back_later` | ● | – | – |
| Onboarding and profile-suggestion tools | ● | – | – |
| `connect_data_source`, `connect_login` | ● | – | – |
| `spawn_worker`, `start_job` | ● | – | – |
| `create_task` (people only, no agent) | ● | – | – |
| `web_search`, `fetch_page`, `market_data`, `x_search`, `reddit_search` | ● | ● | – |
| `exa_search` | – | ○ | – |
| `call_api` | ● GET | ● | – |
| `run_code`, `run_command`, `write_file` | setup only | ● | – |
| `read_file`, `list_files` | setup only | ● | ● (children's files) |
| `browse`, `browser_login` | setup only | ● | – |
| `use_browser` | – | ● | – |
| `github_api` | ● (theirs) | ● | – |
| `save_page`, `read_page`, `refresh_page`, `share_page` | – | ○ | – |
| `use_skill`, `find_skill` | ● | ● | ● |
| `propose_skill` | ● | – | – |
| `escalate` | – | ● | – |
| `finish`, `ask`, `post_update` | – | ● | ● |
| `attach_file`, `save_output`, `set_schedule`, `stop_schedule` | – | ● | ● |
| `start_child`, `message_child`, `cancel_child` | – | – | ● |
| `request_approval` | – | ● | ● |

"Setup only" means the chat agent keeps its own sandbox and browser only for setting up connections, where it reads docs behind a sign-in. All other code and browser work goes to a worker.

### New tools

| Tool | Takes | Does |
|---|---|---|
| `spawn_worker` | title, brief, skills, people?, files?, repeat?, share?, model?, `wait`? | Starts a task for the Worker with those skills pinned. With `wait`, it runs inline in the person's sandbox for up to 3 minutes (today's `ask_specialist`); if it needs longer, it becomes the task. Replaces `create_task` with agents, `start_coding`, `start_research` and `ask_specialist` |
| `start_job` | title, request, skills?, people?, files?, repeat?, share? | Starts a job: a task for the coordinator, with the request as its brief. Replaces `plan_job` |
| `start_child` | assignee (worker, person or script), title, brief, skills?, after?, files? | A child task on the job, created for the person the job is for. Children started in one step are one batch |
| `message_child`, `cancel_child` | child, text | Reply on a child (an answer, or "redo this"), or stop it |
| `escalate` | why, what it found | Turns the worker's task into a job. A coordinator takes over |
| `use_skill` | name | Loads a skill: its text, its scripts into the sandbox, the tools it switches on, and any company skill that extends it |
| `find_skill` | words | Searches the catalogue, once it's too long to list |
| `propose_skill` | name, text or an edit, why | From chat ("save this as a skill"): a suggestion card for a person to apply |
| `request_approval` | what, items or a file | Asks the person to approve exact content. Returns an approval that later writes must name |

Gone: `hand_off`, `plan_job`, `ask_specialist`, `start_coding`, `start_research`, `investigate`, `create_agent`, `read_integration_guide` and `save_integration_guide`. Agents read a connection's system skill with `use_skill`, and the learner keeps it up to date.

**The learner's tools** are separate, since it isn't one of the four agents:
- `read_run`: the full run behind a digest.
- `use_skill`.
- `run_script_test`: in the job's sandbox.
- `draft_skill_change`: returns the checks' result and how the change will be applied.

## Gates in code

Prompts ask agents to get approval before changing other systems. With no limits by agent, these gates are what make that hold.

- **Each tool declares what it touches**: `read`; `write`, meaning inside Mach1; or `external`, meaning outside it. External ones include:
  - `call_api` with anything but GET;
  - `use_browser` when it changes something;
  - writes through `github_api`;
  - sending files to anyone but the asker;
  - anything that pays.
- **External writes need an approval** from `request_approval` that covers them.
  - The other way through is a skill an admin has marked as pre-approved for one narrow kind of write, e.g. `coding-in-github` opening pull requests in the person's repositories.
  - The check runs before the tool does anything, in the wrapper every task tool already passes through (`narrated()` in `lib/agents/runner.ts`). The chat agent's tools get the same wrapper.
- **Approvals are bound to content.** An approval stores exactly what was approved: the list, or a hash of the file. A write outside it is refused, with a message the agent can act on. Scripts get the approval through their environment and are expected to check against it. The proxy refuses non-GET requests to a connection when a run has no approval.
- **The browser can't be checked by code alone**, since a click is just a click. When the browser agent is given an approval, each step that changes something is first checked against the approved content by a separate model call that doesn't share the agent's goal. This is what Instinct describes as its decoupled monitor.
- **Cost.** `start_job` estimates the cost from the plan. Above a company setting, the person approves the plan before any child starts.
- **Ledgers.** Writes made in a loop record what's done, in the job's folder on the drive, so a retry carries on instead of repeating. The `reconciliation` skill requires one, and so does the gate for repeated external writes.

## The scenarios, worked through

1. **Open tasks.** The chat agent answers from its context. No tool call.
2. **Invite.** `do_action person.add` with name, email, phone and `invite: true` (admins only). The number is stored as contact details only. The reply says they link WhatsApp themselves once they've joined.
3. **Issues.**
   - The chat agent asks which repository if it isn't clear, then calls `start_job`.
   - The coordinator lists issues since last night with `github_api` and drops duplicates and anything that isn't a bug.
   - It starts one worker child per issue, as one batch, with `coding-in-github` and `issue-triage`. Each child has its own sandbox, branch and pull request, and is created for the person, so their GitHub is attached.
   - When the batch is done, the coordinator reviews each child: checks green, and a new test that reproduces the issue. It sends weak ones back.
   - It reports once: fixed (with links), couldn't reproduce, needs a decision.
   - Opening pull requests is pre-approved by `coding-in-github`. Merging needs the person's word.
4. **Memory stocks.**
   - The coordinator asks first: which companies, and what format.
   - It shows the plan with a cost estimate and starts once the person approves.
   - First batch: research children in parallel, one per sector question (DRAM and NAND pricing, HBM, capacity and capex, demand). Each reports findings with sources.
   - The coordinator writes the sector view and the shared scenario assumptions to `/vercel/drive/jobs/<job>/assumptions.json`.
   - Second batch: one worker child per company, with `research`, `financial-analysis` and `excel-models`, building each model on those assumptions.
   - Then one worker child with `presentations` builds the deck from the models.
   - Before reporting, the coordinator checks that the same scenarios are used everywhere and that the deck's numbers match the models.
5. **Kalshi and state rules.**
   - The chat agent splits the request into two `spawn_worker` calls with `repeat` and `data-pipelines`.
   - Each first run works out its site (using the browser agent if needed), writes scripts that pull the data and draw the charts, keeps history on the drive, and delivers.
   - When the round closes, the gate says yes (new scripts that worked, work that repeats). The learner saves a system skill for each site, with its scripts. It's applied automatically.
   - Each month after, the scripts replay with no model. The states job's `SUMMARY:` line says what changed since last month.
   - The chat agent also offers a Page.
6. **Masttro.**
   - **First week.**
     - The chat agent calls `start_job` with a weekly `repeat`.
     - The coordinator plans and asks anything unclear.
     - When the job closes, the gate says yes. The learner writes the workflow skill `masttro-weekly-tagging`: the routing (Hassan Daher and his entities to Rita, Wissam Daher to Mawla, everything unclear to Mustapha), the 98% target, the approval step, and the scripts `pull_untagged.py`, `classify.py` and `tag_cmr.py`. It's a new workflow skill, so your Chief of Staff asks you, and you apply it. The first weeks' answers seed its decision history, and Masttro's already-tagged transactions can seed it on day one.
   - **Every week after**, the coordinator loads that skill:
     1. A script child runs `pull_untagged.py` against the read-only API, and fetches the current tag list.
     2. A script child runs `classify.py`. For each transaction:
        - Code works out the facts: the counterparty seen before, the amount against its history, and how often it recurs.
        - It retrieves up to ten closest past transactions with their final tags.
        - It asks Jev three things: which tag (the current tag list plus "none"), which entity (Hassan Daher's, Wissam Daher's, other, or unknown), and whether this repeats an earlier transaction.
        - Transactions above the backtested threshold for the 98% target are tagged automatically. The rest are routed by the skill's rules: Hassan Daher's entities to Rita, Wissam Daher's to Mawla, everything else to Mustapha, each with Jev's suggestion filled in.
     3. Person children go to Rita, Mawla and Mustapha, each with their own list, to confirm or change. Their assistants tell them on WhatsApp, and anyone who hasn't answered gets a nudge after a day. Every answer goes into the decision history.
     4. The coordinator combines the answers and calls `request_approval` with the full list. You approve it or change it.
     5. A script child runs `tag_cmr.py` (Playwright, signed in with the Masttro login) on the approved list. It keeps a ledger and takes screenshots. If the site has changed and the script fails, a worker fixes it with the browser agent, step-checked against the approval. After the job, the learner saves the fixed script, applied automatically once its test passes.
     6. One report.
   - Items still open when next week's run starts carry into it.
   - This only works for team members. Mach1 can't message anyone outside the company.

## Data

| Change | |
|---|---|
| `tasks.parent_task_id`, `tasks.assignee_kind` | The job a child belongs to, and whether its assignee is a worker, a person or a script |
| `tasks.skills`, `tasks.model`, `tasks.effort` | Skills pinned to the task, and the model chosen when it was started |
| `agents` | One built-in row, `builtin = 'worker'`. No new defined, worker, coding or research agents are made. Existing ones finish their open tasks, then are archived |
| `skills`, `skill_versions` | Company skills: kind (system or workflow), owner, visibility, text, front matter, `extends`, scripts (file-library versions), author and source task per version |
| `integrations.agent_ids` | Dropped. `person_ids` stays. `guide` becomes the first version of the connection's system skill |
| `approvals` | The task, what was proposed and what was approved (items or a hash), who approved it and when, and what it covers |
| `run_log` | One row per run: skills pinned and loaded, every tool call (with the script path and exit code), and the number of model steps. The digest is built from it |
| `skill_decisions` | A skill's decision history: the state, options, Jev's probabilities and model version, the threshold, and the outcome (applied automatically, confirmed, or changed, and by whom). Used for retrieval, backtests and the learner |
| `learning_reviews` | One row per review: the gate's answers and model version, whether the learner ran, what it decided, the changes and how each was applied (automatically, applied by a person, declined). The gate's eval set |

**Moving existing companies over:**
- Each defined agent's role and instructions become a company workflow skill named after it, pinned to its open tasks.
- Each integration's guide becomes a system skill.
- Rules that every agent shared go into the profile's How We Work section, as a suggestion for a person to apply.

## Phases

1. **One worker, base skills in files.**
   - The Worker with pinned skills replaces the Developer, the Researcher and the worker agent made per task.
   - Limits by agent on integrations go.
   - Old tool results are trimmed in long runs.
   - Base skills move to `skills/<name>/SKILL.md`.
   - Until jobs exist, the research skill keeps `investigate`, so briefs don't get worse in between.
2. **One hand-off.** `spawn_worker` (with `wait`) and `escalate` replace `create_task` with agents, `start_coding`, `start_research` and `ask_specialist`.
3. **Jobs.**
   - Parent and child tasks, with worker, person and script children.
   - Batches that wake the coordinator once, and one report per job.
   - In-depth research moves to jobs. `plan_job` and `investigate` go.
4. **Learning on the job.**
   - Company skills with scripts and tests, and system skills taking over from guides.
   - The run log, digests, the gate (Jev, with the `background` model as fallback) and the learner, with checks and approval tiers.
   - `mach.decide` in the sandbox template, the decision history, retrieval of past cases, and backtested thresholds.
   - `propose_skill` from chat, suggestion cards, and the Skills page with its actions.
   - Workflow skills saved by repeating jobs, `extends`, and `find_skill`.
   - Defined agents become workflow skills, and the Team page lists people only.
5. **Gates.** Tool effects, `request_approval`, the proxy refusing writes without an approval, the step check for the browser, cost approval, and ledgers.
6. **Long work leaves the chat turn.** Code, the browser and pages move to workers, except setting up connections.

Each phase ships on its own. Phases 3, 4 and 5 are the large ones.

## Acceptance tests

The six scenarios above, plus one for learning. Each is run against a test company with scripted models (`test/scripted-model.ts`) for routing and orchestration, and once by hand with real models before each phase ships.

1. Answered with no tool call.
2. One `person.add` with an invite, and no attempt to link WhatsApp.
3. One job with one child per real issue. Each child has a pull request and a test that fails before the fix. One report.
4. Questions asked before work starts, and a plan with a cost, approved. One assumptions file, read by every model. A deck whose numbers match the models.
5. Two repeating tasks, each with a system skill and scripts. The next run replays with no model call, and its `SUMMARY:` line says what changed.
6. Person children to the right people, with Jev's suggestions filled in. Auto-tags only above the backtested threshold, and none while the history is too short. An approval before any write, and writes outside it refused. A retry that resumes from the ledger.
7. **Learning.**
   - The first week of scenario 6 ends with the gate saying yes, and the learner writing `masttro-weekly-tagging`, which reaches you to apply.
   - The second week loads the skill, plans nothing, and makes model calls only for exceptions. Its gate says no, and no learner runs.
   - A script broken on purpose is fixed during the job. The learner saves the fix automatically, and its test passes.
   - A correction from Rita ("the trust is mine too") reaches you as a question, not a silent edit.

## Open questions

- **A company memory** that workers can write to, like Claude Code Projects' `MEMORY.md`, for facts that aren't procedures ("the release moved to May"). For now the profile and skills cover it.
- **People outside the company** (scenario 6 with an outside accountant). This needs outbound email, or an approved WhatsApp template, neither of which Mach1 sends today.
- **TypeSafe's data terms.** Digests hold business data, such as Masttro transactions. Check how TypeSafe retains and uses what it's sent before turning the gate on. Until then, or for a company that says no, the `background` model fallback answers instead.
- **Jev is new** (September 2026). Pin the version, watch the gate's eval set, and keep the fallback working. How the AI SDK calls typed questions through AI Gateway still needs checking.
- **Base skills that change under a company's extensions.** Extensions are short additions, so they should survive most changes. A base skill's scripts are an interface, though, and changing them needs care.
- **The coordinator's effort.** Low effort keeps its turns cheap, but review steps may want more. This could be set per job.
- **Importing community skills** in the Agent Skills format. Useful, but a skill is instructions, so each one needs reviewing first.

## Code

Where it will live:

| Path | |
|---|---|
| `lib/agents/chief-of-staff.ts` | The chat agent: routing rules, `spawn_worker`, `start_job` |
| `lib/agents/runner.ts`, `run-steps.ts` | The worker and the coordinator (same runtime), `escalate`, trimming, child events, the gate in `narrated()` |
| `lib/agents/jobs.ts` | Jobs and children: `start_child`, `message_child`, batches, waking the coordinator, carry-over |
| `lib/agents/approvals.ts` | `request_approval`, tool effects, the browser step check |
| `skills/<name>/` | Base skills: `SKILL.md` and scripts |
| `lib/skills/` | Loading, the catalogue, `extends`, `find_skill`, company skills and their versions, `propose_skill`, script tests |
| `sandbox/` (template), `lib/skills/decisions.ts` | `mach.decide`, the proxy rule that lets it reach Jev, the decision history, retrieval and backtests |
| `lib/learning/` | The run log, digests, the gate (Jev through AI Gateway), the learner, checks, classifying changes, applying them or asking the owner |
| `lib/actions/skills.ts`, `app/(app)/skills/` | Skill actions and the Skills page |
| `lib/integrations.ts` | Connections: limits by agent removed, guides moved to system skills |
| `lib/agents/store.ts` | The built-in Worker |
