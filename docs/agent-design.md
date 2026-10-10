# Agents, skills and tools

**Status: proposed 2026-10-10.** Not built yet. Once built, it replaces "Asking a specialist" and "Big jobs: the coordinator" in [assistant.md](assistant.md), the Developer and the Researcher as agents ([github.md](github.md), [research.md](research.md)), and the worker agent made for each task.

## Goal

People ask in chat, and three kinds of agent do the work:

- **The chat agent** (today's Chief of Staff) answers fast and cheaply. It does what it can in the turn and hands off the rest.
- **A worker** does one piece of work on a task, with whatever skills that work needs.
- **A coordinator** runs a big job or a process. It plans, starts the parts (workers, people, scripts), checks what comes back and reports once.

What makes work "research" or "coding" is a **skill** the worker loads, not a different agent. Going wide (in-depth research, many issues at once) is always a job: the coordinator splits the work and workers do the parts in parallel. The only other agent loop is the browser agent, which earns its own (below).

That's the whole set: **chat agent, coordinator, worker, and the browser agent**. Profiles are settings a worker runs with, not agents. The planner becomes the coordinator's model.

## Why

- **Today's role agents are already one agent.** Every task agent runs the same loop (`runAgentOnTask`) with the same tools. The Developer's instructions are one line: "Load the coding-in-github skill before you start, and follow it." The Researcher's are the same with the research skill, plus `exa_search` and `investigate`. A worker agent is a role name made for one task. `coder` and `worker` are the same model in both lineups.
- **Big jobs have no owner.** `plan_job` writes a plan as text, the cheapest model turns it into tasks with `after`, and `startFollowers` starts them in order. Nothing checks the parts or puts them together. Each task reports to people on its own.
- **Long work runs in the chat turn.** The Chief of Staff runs code, the browser and page building inside a request that may last 800 s and isn't durable.
- **It's where the field has landed.** In Claude's Agent SDK and Claude Code ([subagents](https://code.claude.com/docs/en/sub-agents)), every worker is the same kind of session. Subagents are used for three reasons only: verbose work kept out of the main context, restricted tools, and parallel work. Reusable know-how is a skill ([Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). [Claude Code Projects](https://code.claude.com/docs/en/claude-projects) (beta) adds one coordinator that starts generic threads, sees only what they report, and shares a memory with them. Instinct, from what it has said in public, is one generalist agent with checks around it that aren't agents.

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

## The agents

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

### Chat agent

One per person per company, as today: the same conversation from the panel, WhatsApp and email, one turn at a time, on the `chat` model.

It does these in the turn:

- Answers from what it already has: the profile, open tasks, files, pages, the team.
- Does actions with `do_action`, with the person's permissions.
- Quick lookups: `web_search`, `fetch_page`, `market_data`, `x_search`, `reddit_search`, `find_tasks`, `read_task`, a GET with `call_api`.
- Setting up integrations, because the credentials card and the sign-in code card live in the chat.
- Onboarding and profile suggestions.

It hands everything else off, using these rules:

1. The context or one quick tool covers it: answer.
2. One thing to change in the app: `do_action`.
3. One deliverable, one kind of work: `spawn_worker`. If the answer is likely within a few minutes, pass `wait` and answer in the chat. If it needs longer, it becomes a task that reports back.
4. Several deliverables that depend on each other, a process with people or an approval in it, in-depth research, or a shape it can't know until someone looks: `start_job`.
5. Unsure between 3 and 4: a worker. It can escalate.

It writes the brief: the request with everything from the conversation that the work needs, since workers don't see the chat. It also writes which skills to load, and who the work is for.

### Worker

One built-in agent per company, called **Worker**. It replaces the Developer, the Researcher, and the worker agent made for each task. It works on a task in the agent-run workflow exactly as task agents do today: the same lease, the same turn limits, the same durable steps (`lib/agents/runner.ts`).

- **What it reads**: the task brief as today, plus the skills pinned to the task, already loaded. A worker can load more with `use_skill`.
- **Running as a profile**: a task can name a profile (below). The worker then also gets that profile's instructions, model, pinned skills and allowed integrations.
- **Model**: the task's model if one was set when it was started, else the profile's, else the pinned skill's default, else the company's model for agents, else the `worker` role.
- **How a run ends**: `finish`, `ask` or `hand_off`, as today. On a job's child task, these go to the coordinator first (see Coordinator).
- **Escalating**: when a worker finds the work needs a plan or needs to go wide (it found eight issues, not one; the question splits into six), it calls `escalate`. Its task becomes a job and a coordinator takes over. The worker's findings become the coordinator's first input. Workers never start other agents themselves.
- **Long runs**: before each model call, older tool results (search hits, whole pages, command output) are trimmed to a short note of what they held. That way a run that reads a lot keeps a working context without needing a second agent.

### Profiles: what the company's own agents become

The agents a company defines on the Team page ("Sales outbound", "Data entry") stay, as **profiles**. A profile is a name, standing instructions, a model, the skills it always loads, and the integrations it may use. A worker runs as a profile when a task names it.

They stay for three reasons:

- **Integration limits.** Today an integration can be limited to chosen agents, for example "only Data entry gets the Masttro login". That limit needs something to attach to.
- **A model per kind of work.** A company can choose one, as it does per agent today.
- **People think in names.** "Ask the analyst" should keep working.

Profiles are the `agents` rows of kind `defined`, as today. Nothing about them changes, except that built-in agents stop being made and worker agents stop being made per task.

### Coordinator

The agent of a **job**: a task with child tasks. It runs on the job's own task in the agent-run workflow, on the `planner` model (Opus 5.5 at low effort, or GPT-6 Astra). It takes over from `plan_job`.

**Its turns are short**, and each is a run like any other:

1. **First run.**
   - Settles what to ask first. The person answers on the job's task, through `ask`.
   - Writes the plan into the job's thread.
   - Shows a cost estimate when it's over the company's limit, and waits for the person to approve.
   - Starts the children that can start now.
   - Ends.
2. **Later runs.** Children started together are a batch. The coordinator wakes once when the whole batch has delivered, not once per child, because each of its turns is on the planner model. It also wakes as soon as a child asks something or fails, or a person writes on the job. Each run does any of these:
   - Reviews what came back.
   - Answers the child, or sends it back with a reply.
   - Starts the next children.
   - Asks the person.
3. **Last run.** Puts the result together (a file, a deck, a table) and reports with `finish`. This is the only report the person gets.

**Children** are tasks with one assignee each:

| Assignee | What it is | Example |
|---|---|---|
| Worker | A task for the Worker, with skills, optionally as a profile | Fix issue #412; model SK hynix |
| Person | A task with only that person on it: a question or a list to go through. Their own assistant tells them, and their answer comes back on the task | Rita: tag these 14 transactions |
| Script | A task whose `run.sh` replays without a model. If it fails, a worker is woken to fix it | Pull untagged transactions from Masttro |

**Rules for children:**

- **Who they're for.** Children are created for the person the job is for, never "by the coordinator". Whose accounts a run may use follows from who it's for (`workingForId`): their GitHub, and the integrations they're allowed.
- **Who hears about them.** A worker child's `ask` and `finish` wake the coordinator, not people. The coordinator answers or asks the person. People can still open a child and write on it directly. A person child notifies its person, which is its job.
- **Order.** `after` works as today: a child waits in backlog until the children it needs have delivered.
- **Depth.** Children can't start jobs. A worker child that needs a plan tells the coordinator, which re-plans.
- **Limits.** At most 8 children running at once, and 40 per job. The coordinator's messages don't reset a child's count of agent turns, so the six-turn limit still stops a loop between them.

**Repeating jobs.** A job can carry a schedule. Its first successful run saves its plan as a **runbook**: a skill owned by whoever asked for the job, and private like their tasks. Later runs load the runbook and don't plan again unless it fails. If the last run's children are still open when the next one is due, the coordinator carries the open items into the new run instead of skipping it.

**Research is a job.** In-depth research works like any other job:
1. The coordinator frames the question with the `research` skill (the decision it's for, what a good answer holds) and splits it into three to six questions.
2. It starts one worker child per question, as one batch. Each child loads `research`, investigates, and finishes with compressed findings: dated, marked Fact, Estimate or Opinion, with numbered sources. It doesn't hand over everything it read, so the coordinator's context stays small.
3. The coordinator reads the batch, starts a second round for the gaps that matter (two rounds at most), then writes the brief.

A quick research question ("what's the market saying about Micron's guidance?") is one worker with `wait`, answering in the chat. This replaces the Researcher's sub-researchers (`investigate`).

### The browser agent: the one separate loop

`use_browser` hands a bounded job on a website to the browser agent. It stays its own agent, unchanged, because:
- it runs on its own vision model;
- a screenshot after every step would swamp the caller's context;
- web pages are untrusted, so the caller should only read the browser agent's report;
- its sessions carry on between calls.

How to use it well becomes a skill, `using-the-browser`.

## Skills

### What a skill is

A playbook for one kind of work. The catalogue (each skill's name and one line on when to use it) is in every agent's instructions. The body is read only when it's loaded (`use_skill`) or pinned to the task, which keeps prompts small.

A skill has:

| Field | |
|---|---|
| `name`, `description` | What it's called, and when to use it, in one line |
| `body` | How to do the work: steps, rules, what good looks like, what to ask first |
| `tools` | Tools it switches on when loaded, from a fixed list (e.g. `exa_search`). A skill never grants an integration, and never any tool the runner hasn't allowed |
| `model` | Optional default: a role (`coder`, `worker`) and effort |
| `files` | Optional scripts and templates copied into the sandbox when loaded (a deck builder, a chart style) |
| `owner`, `visibility` | Company skills only: who wrote it, and private or company, with the same rules as tasks |

Built-in skills use the Agent Skills layout (`SKILL.md` with front matter, plus files), so Mach1's skills and Claude Code's can be read by either.

### Built-in skills

| Skill | For | Status |
|---|---|---|
| `company-profile` | Writing the profile | Today |
| `writing-tasks` | Briefs, titles, who's on it | Today; covers `spawn_worker` and `start_job` briefs |
| `designing-agents` | Profiles: role, instructions, integrations | Today; renamed `designing-profiles` |
| `research` | Framing a question for the decision it serves, investigating one question well, the findings format children report in, writing the brief | Today; switches on `exa_search`. Going wide is a job |
| `financial-analysis` | Statements, valuation, scenarios | Today |
| `excel-models` | Models with working formulas, recalculated | Today |
| `connecting-integrations` | Data sources and logins | Today |
| `building-pages` | Pages and their refresh jobs | Today |
| `coding-in-github` | Branch, change, test, PR, as the person | Today; default model `coder` |
| `coordinating` | The coordinator's playbook: asking first, plan shape, splitting work into batches, children, review, assembly, gates | New |
| `presentations` | Decks with `python-pptx` from a model's numbers, charts in the company's style | New (scenario 4) |
| `data-pipelines` | Pulling a site or API into a `run.sh`: history on the drive, diffs against last time, charts, a `SUMMARY:` line | New (scenario 5) |
| `reconciliation` | Matching against history with fixed rules, sending the rest to people, keeping a ledger | New (scenario 6) |
| `issue-triage` | Finding, deduplicating and reproducing issues before fixing them | New (scenario 3) |
| `using-the-browser` | When to use the browser agent, how to brief it, what needs approval first | New |
| `writing-skills` | Turning a finished job or a correction into a company skill | New |

### Company skills

A company's own procedures: "how we do month-end", "Masttro tagging", "who handles which family entity". They're kept in Postgres with every version, listed on a **Skills** screen, and can be written from chat.

**What goes where** (one home per kind of knowledge):

| Knowledge | Where | Who changes it |
|---|---|---|
| What the company is and wants | Company profile | A person applies a suggestion |
| About one person | Their personal notes | Their assistant, and them |
| One job's state: scripts, parameters, decisions | The job's `NOTES.md` | The job's agents |
| How a system behaves: endpoints, quirks, the clicks through a web app | The integration's guide | Agents, freely |
| How to do a kind of work: steps, rules, who to ask | A skill | A person, or an agent with a person applying it |

### When a skill is added

**Built-in skills** are added by Mach1's developers when all three hold:

- The kind of work recurs across companies.
- Agents get it wrong, or slow, without guidance. Run them on representative requests first and see.
- It doesn't belong in one company's skill, the profile or an integration's guide.

Each new built-in skill ships with a scenario in this document's style, checked before release.

**Company skills** are added in four ways:

1. **Asked for in chat**: "here's how we do month-end, save it". The chat agent drafts it and shows a card.
2. **From a job that repeats**: a repeating job's first good run saves its plan as a runbook (above).
3. **From a finished job**: when a worker or coordinator notices the person will want the same thing again, it proposes a skill with `propose_skill`.
4. **From a correction**: "Rita handles Hassan's trusts too". The agent proposes an edit to the skill it used.

Proposals show up as suggestion cards (like profile suggestions today) on the task and in Needs you. A person applies them. Agents never change a skill on their own, because a skill is instructions every later run follows, and a skill written from an email or a web page could carry someone else's instructions. Skill text is scrubbed of known secret values when saved.

**Actions** go in `lib/actions/skills.ts`, per AGENTS.md: `skill.list`, `skill.show`, `skill.save`, `skill.update`, `skill.set_visibility`, `skill.remove` and `skill.apply_suggestion`. The Skills page carries an `@map` line.

## Tools

Who gets what. ● always, ○ when a skill switches it on, – never.

| Tool | Chat agent | Worker | Coordinator |
|---|---|---|---|
| `do_action` | ● | – | – |
| `find_tasks`, `read_task` | ● | – | ● (its children) |
| `reply_on_task`, `check_back_later` | ● | – | – |
| Profile, onboarding and suggestion tools | ● | – | – |
| `connect_data_source`, `connect_login` | ● | – | – |
| `spawn_worker` | ● | – | – |
| `start_job` | ● | – | – |
| `create_task` (people only, no agent) | ● | – | – |
| `web_search`, `fetch_page`, `market_data`, `x_search`, `reddit_search` | ● | ● | – |
| `exa_search` | – | ○ | – |
| `call_api` | ● GET | ● | – |
| `read_integration_guide`, `save_integration_guide` | ● | ● | – |
| `run_code`, `run_command`, `write_file` | setup only | ● | – |
| `read_file`, `list_files` | setup only | ● | ● (children's files) |
| `browse`, `browser_login` | setup only | ● | – |
| `use_browser` | – | ● | – |
| `github_api` | ● (theirs) | ● | – |
| `save_page`, `read_page`, `refresh_page`, `share_page` | – | ○ | – |
| `use_skill` | ● | ● | ● |
| `propose_skill` | ● | ● | ● |
| `escalate` | – | ● | – |
| `finish`, `ask`, `post_update` | – | ● | ● |
| `hand_off` | – | ● (to a profile on the task) | – |
| `attach_file`, `save_output`, `set_schedule`, `stop_schedule` | – | ● | ● |
| `start_child`, `message_child`, `cancel_child` | – | – | ● |
| `request_approval` | – | ● | ● |

"Setup only": the chat agent keeps its own sandbox and browser for connecting integrations, where it reads docs behind a sign-in. All other code and browser work goes to a worker.

### New tools

| Tool | Takes | Does |
|---|---|---|
| `spawn_worker` | title, brief, skills, profile?, people?, files?, repeat?, share?, model?, `wait`? | Starts a task for the Worker. With `wait`, it runs inline in the person's sandbox (today's `ask_specialist`, up to 3 minutes). If it needs longer, it becomes the task. Replaces `create_task` with agents, `start_coding`, `start_research` and `ask_specialist` |
| `start_job` | title, request, people?, files?, repeat?, share? | Starts a job: a task for the coordinator, with the request as its brief. Replaces `plan_job` |
| `start_child` | assignee (worker, person or script), title, brief, skills?, profile?, after?, files? | A child task on the job, created for the person the job is for. Children started in one step are one batch, which wakes the coordinator once when all have delivered |
| `message_child`, `cancel_child` | child, text | Reply on a child (an answer, or "redo this"), or stop it |
| `escalate` | why, what it found | Turns the worker's task into a job. A coordinator takes over |
| `request_approval` | what, items or file | Asks the person to approve exact content. Returns an approval that later writes must name |
| `propose_skill` | name, body or an edit, why | A suggestion card for a new skill or an edit |

## Gates in code

Prompts ask agents to get approval before changing other systems. These gates make the important cases hold even when a prompt doesn't.

- **Tools declare what they touch**: `read`, `write` (inside Mach1) or `external` (outside it). External ones include: `call_api` with anything but GET, `use_browser` with a change, `github_api` writes, sending files to anyone but the asker, and anything that pays.
- **External writes need an approval** from `request_approval` that covers them. The other way through is a profile or company skill setting that pre-approves a narrow kind, for example "open pull requests in our repos". The check runs in the wrapper every task tool already passes through (`narrated()` in `lib/agents/runner.ts`), before the tool does anything. The chat agent's tools get the same wrapper.
- **Approvals are bound to content.** An approval stores what was approved (the list, or a hash of the file). A write outside it is refused, with a message the agent can act on.
- **The browser can't be checked by code alone**, since a click is a click. When the browser agent is given an approval, each step that changes something is checked first against the approved content by a separate model call that doesn't share the agent's goal. This is what Instinct describes as its decoupled monitor.
- **Cost**: `start_job` estimates cost from the plan. Above a company setting, the person approves the plan before children start.
- **Ledgers**: writes made in a loop record what's done (on the drive, in the job's folder), so a retry carries on instead of repeating. The `reconciliation` skill requires one, and so does the gate for repeated external writes.

## The scenarios, worked through

1. **Open tasks.** The chat agent answers from its context. No tool call.
2. **Invite.** `do_action person.add` with name, email, phone and `invite: true` (admins). The number is contact details only. The reply says they link WhatsApp themselves once they've joined.
3. **Issues.**
   - The chat agent asks which repository if it isn't clear, then calls `start_job`.
   - The coordinator lists issues since last night with `github_api`, drops duplicates and anything that isn't a bug, and starts one worker child per issue with `coding-in-github` and `issue-triage`. Each child gets its own sandbox, branch and pull request.
   - The coordinator reviews each one as it delivers: checks are green, and the new test reproduces the issue. It sends weak ones back.
   - It reports once: fixed (with links), couldn't reproduce, needs a decision.
   - Every child is created for the person, so their GitHub is attached. Opening a pull request in their repository is pre-approved by `coding-in-github`. Merging needs their word.
4. **Memory stocks.**
   - The coordinator asks first: which companies, and what format.
   - It shows the plan with a cost estimate, and starts once the person approves.
   - First batch: research children in parallel, one per sector question (DRAM and NAND pricing, HBM, capacity and capex, demand). Each reports findings with sources.
   - The coordinator writes the sector view and the shared scenario assumptions to `/vercel/drive/jobs/<job>/assumptions.json` from what they found.
   - Second batch: one worker child per company, in parallel, with `research`, `financial-analysis` and `excel-models`, building each model on those assumptions.
   - Then one worker child with `presentations` builds the deck from the models.
   - The coordinator checks the same scenarios are used everywhere and that the deck's numbers match the models before it reports.
5. **Kalshi and state rules.**
   - The chat agent splits the request into two `spawn_worker` calls with `repeat` and the `data-pipelines` skill.
   - Each first run works out the site (with the browser agent if it needs one), writes `run.sh` (Playwright directly, where a browser is needed), keeps history on the drive, and delivers.
   - Each month after, `run.sh` replays with no model. The states job's `SUMMARY:` line says what changed since last month.
   - The chat agent offers a Page as well.
6. **Masttro.** The chat agent calls `start_job` with `repeat` weekly. The first run plans, asks anything unclear, and saves the runbook as a company skill. Each run:
   1. A script child pulls untagged transactions with `call_api` (read-only).
   2. A worker child with `reconciliation` sorts them by fixed rules. Transactions for Hassan Daher and his entities go to Rita; for Wissam Daher, to Mawla. Repeats that exactly match past tags (same counterparty, same description pattern, amount within the usual range) are auto-tagged. Everything else goes to Mustapha. "98% confident" is these rules, not a number a model states.
   3. Person children go to Rita, Mawla and Mustapha, each with their own list. Their assistants tell them on WhatsApp. Stragglers get a nudge after a day.
   4. The coordinator combines the answers and calls `request_approval` with the full list. You approve or change it.
   5. A worker child with the Masttro login (profile: Data entry) tags each approved transaction through the browser agent, step-checked against the approval, keeping a ledger and screenshots.
   6. One report.

   Items still open when next week's run starts carry into it. This only works for team members: Mach1 can't message anyone outside the company.

## Data

| Change | |
|---|---|
| `tasks.parent_task_id` | The job a child belongs to |
| `tasks.assignee_kind` | `worker`, `person` or `script`, for children |
| `tasks.skills`, `tasks.model`, `tasks.effort` | Pinned skills, and the model chosen when it was started |
| `agents.builtin = 'worker'` | The Worker. `coding` and `research` stop being made; their existing tasks keep running as they are |
| `skills`, `skill_versions` | Company skills: owner, visibility, body, files, tools, versions |
| `approvals` | The task, what was approved (items or a hash), who approved and when, and what it covers |

## Phases

1. **One worker.** The Worker and pinned skills replace the Developer, the Researcher and per-task worker agents. `exa_search` comes with the research skill. Until jobs exist, the research skill keeps `investigate` too, so briefs don't get worse in between. Old tool results are trimmed in long runs. Built-in skills move to `SKILL.md` files, collected at build time like `lib/app-map.json`.
2. **One hand-off.** `spawn_worker` (with `wait`) and `escalate` replace `create_task` with agents, `start_coding`, `start_research` and `ask_specialist`.
3. **Jobs.** Parent and child tasks, batches that wake the coordinator once, `start_job` and `start_child` with worker, person and script children, one report, and runbooks for repeating jobs. In-depth research moves to jobs. `plan_job` and `investigate` go.
4. **Company skills.** The table, the Skills page and its actions, `propose_skill`, and suggestion cards.
5. **Gates.** Tool effects, `request_approval`, the step check for the browser, cost approval and ledgers.
6. **Long work leaves the chat turn.** Code, the browser and pages move to workers, except integration setup.

Each phase ships on its own. Phases 1, 2 and 4 change little that people see. Phases 3 and 5 are the large ones.

## Acceptance tests

The six scenarios above, run against a test company with scripted models (`test/scripted-model.ts`) for routing and orchestration, and once by hand with real models before each phase ships:

1. Answered with no tool call.
2. One `person.add` with an invite. No attempt to link WhatsApp.
3. One job, one child per real issue, each with a pull request and a test that fails before the fix. One report.
4. Questions asked before work starts. A plan with a cost, approved. One assumptions file read by every model. A deck whose numbers match the models.
5. Two repeating tasks. A replay with no model call at the next run, and a `SUMMARY:` line that says what changed.
6. Person children to the right people. Auto-tags only for rule matches. An approval before any write. Writes refused outside the approval. A retry that resumes from the ledger. A runbook saved, and loaded the next week.

## Open questions

- **A company memory** that workers can write to, like Claude Code Projects' `MEMORY.md`, for lessons that aren't procedures ("the release moved to May"). For now the profile, guides and skills cover it.
- **People outside the company** (scenario 6 with an outside accountant). This needs outbound email or an approved WhatsApp template, which Mach1 doesn't send today.
- **The Team page**: whether jobs, and the Worker itself, show there.
- **The coordinator's effort**: low effort keeps its turns cheap, while review steps may want more. This could be per job.
- **Importing community skills** in the Agent Skills format. Useful, but a skill is instructions, so each one needs reviewing first.

## Code

Where it will live:

| Path | |
|---|---|
| `lib/agents/chief-of-staff.ts` | The chat agent: routing rules, `spawn_worker`, `start_job` |
| `lib/agents/runner.ts`, `run-steps.ts` | The Worker and the coordinator (same runtime), `escalate`, trimming old tool results, child events, the gate in `narrated()` |
| `lib/agents/jobs.ts` | Jobs and children: `start_child`, `message_child`, batches, waking the coordinator, carry-over |
| `lib/agents/approvals.ts` | `request_approval`, tool effects, the browser step check |
| `skills/<name>/SKILL.md`, `lib/agents/skills.ts` | Built-in skills and loading. Company skills from the `skills` table |
| `lib/actions/skills.ts`, `app/(app)/skills/` | Skill actions and the Skills page |
| `lib/agents/store.ts` | The built-in Worker. Profiles (defined agents) |
