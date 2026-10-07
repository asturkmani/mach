# Sandboxes and files for coding and analysis jobs

**Status: decided 2026-10-07. Phase 1, recurring jobs and the company drive are built; the rest of phase 2 follows.**

Builds on [F5.4 Sandbox](spec.md#f54-sandbox) in the product spec, and replaces its "one persistent sandbox per agent" with one per job (see Decisions).

## Goal

Agents that need to compute something (a financial model, a simulation, a backtest, a data pull) write and run code in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) and hand back real files: an `.xlsx` model with working formulas, CSVs, charts. The code they ran is attached too, so anyone can check or rerun it, but it sits behind the deliverables rather than in front of them. Jobs can be one-off, iterative ("now try rules ABD") or recurring ("every weekday at 4pm"), and they keep their sandbox, files and notes for as long as the job exists.

## What the person sees

1. They ask the Chief of Staff (or create a task): "Run a Monte Carlo simulation of our 60/40 portfolio over one year and give me an xlsx model."
2. The task comes back to their inbox: *"Median 1-year return is 6.1%, with a 5% chance of losing more than 12%. Model attached. Share it with the family?"*
3. On the task page:
   - **Files** (front and centre): `portfolio-model.xlsx` with a preview of its sheets, its version (v2, v1 from #12) and a download button; charts shown inline; CSVs as tables.
   - **Code** (collapsed, one click away): the scripts the agent wrote, each with the output of its last run.
4. Next week they reply on the same card, "try 70/30": the same agent picks it up in the same sandbox, edits the config, reruns and attaches v2 of the model next to v1.

## Jobs, rounds and archiving

- A card is a **job**. Each time an agent works it is a **run**; a round ends when the job comes back to the inbox.
- **Done** means this round is finished. The job's sandbox stops (Vercel keeps its disk) and its agents stay. Replying on a done job reopens it.
- **Archived** means the job is retired: its sandbox and worker agents are deleted. Its files stay in the company library.
- Three shapes of job:
  - **One-off** ("book flights"): archived automatically after 30 days with no activity, with a heads-up first. *(phase 2)*
  - **Iterative** (backtest rules ABC, then ABD): reply on the same card; never auto-archived.
  - **Recurring** ("every weekday at 4pm, chart today's option flow"): a schedule on the card; each run's result lands in the inbox as an update on the same card, worked in the same sandbox. See Recurring jobs.

## Sandboxes

- **One sandbox per job**, named after the task (`mach-task-<id>`), created the first time an agent on the job runs code. Any agent can use one; agents that never run code never start one.
- **Kept until the job is archived.** It is stopped at the end of every run (Vercel saves the filesystem) and resumed by name on the next run, so scripts, installed packages and downloaded data are where the agent left them.
- **Base setup**: every job sandbox starts from a company-wide template with the data stack installed: Python 3.14 with pandas, numpy, scipy, statsmodels, scikit-learn, numpy-financial, openpyxl, xlsxwriter, matplotlib, seaborn, pyarrow, duckdb, requests, httpx, beautifulsoup4, python-docx, python-pptx and tabulate; LibreOffice (to recalculate xlsx formulas so models can be checked and previewed); Node 24; and uv for anything else. The template is built once and snapshotted.
- **Layout** inside the sandbox: `/vercel/job/code` (scripts), `/vercel/job/inputs` (files attached to the job), `/vercel/job/outputs` (deliverables), and `/vercel/job/NOTES.md` (job memory).
- **Limits**: 2 vCPUs and 4 GB per sandbox; a single command runs for at most 4 minutes in phase 1. Longer jobs run detached and the workflow checks on them between steps *(phase 2)*.
- **Safety**: no secrets in the sandbox; no environment variables are passed in and model calls happen outside it (SBX-5). Network egress is open and logged. Credentials for data APIs (an options feed) are added to outgoing requests at the network layer by Vercel Sandbox's request transformations, never stored inside *(phase 2)*.
- **Company drive**: every job sandbox sees the company's shared data at `/vercel/drive` (see The company drive).
- **Later**: an optional **sandbox per defined agent** for specialist agents that accumulate their own data *(phase 2)*.

## Files: the company library

- Every file an agent attaches, and every script it runs, goes into the **company file library** with **versions**: name, kind (deliverable or code), and for each version its size, type, which task and agent produced it, and which version it was built from.
- **Storage** is Vercel Blob (private) when a Blob store is connected to the project, and Postgres otherwise; the app reads both. Downloads go through Mach, which checks the person is in the company.
- A job's **inputs** are library files attached to it, by a person on the task page or by the Chief of Staff when it creates the job. They are copied into the sandbox's `inputs` folder when the run starts. Saving a file with the same name as one of the job's files makes a **new version of that file**, not a new file.
- If two jobs edit the same version at once, both versions are kept and the later one notes which version it was built from.
- Sandboxes are scratch space, not the system of record: if a sandbox is lost, a fresh one is rebuilt from the library (inputs, deliverables, code) and the job's notes.

## The company drive

Shared data that every job can read and add to: a price history a daily job appends to, an export someone dropped in, a dataset a backtest reuses.

- **Storage**: Vercel Blob (private), one object per file, described by a `drive_files` row (path, size, sha256, which job, agent or person last wrote it). Each path holds its latest content; there are no versions (deliverables have those, in the file library). Postgres holds the content instead when no Blob store is connected.
- **In the sandbox**: `/vercel/drive`. When a run starts, the sandbox gets what changed since it last looked (compared by sha256 against a manifest in the job folder) and loses what was deleted, up to 1 GB per run. After every command, files written under `/vercel/drive` are saved back; files over 100 MB stay in that sandbox. Deleting a file in a sandbox doesn't delete it from the drive; people delete from the Files page.
- **Conflicts**: last write wins per file. Jobs are told to write in folders named for what they hold and not to overwrite other jobs' data unless that's the point.
- **People**: the Files page lists the drive by folder, with downloads, deletes and uploads (straight from the browser to Blob, up to 100 MB a file).
- **Agents** see the drive's newest 40 files in their brief and can list the rest.

## Recurring jobs

- A job can carry **one schedule**: a five-field cron expression in a timezone (IANA name), set by the Chief of Staff when it creates the job (`create_task` with `repeat`), by an agent on the job (`set_schedule`, `stop_schedule`) or by a person in the job's Repeats panel. Runs are at least 15 minutes apart. The company's timezone is taken from the first browser that opens Mach and used as the default.
- **Firing**: Vercel Cron calls `/api/cron/tick` every minute (`vercel.json`, authenticated with `CRON_SECRET`). The tick takes every due schedule, moves it to its next run from now (missed runs aren't replayed one by one) and starts a `scheduled-run` workflow. Archived and cancelled jobs, and paused schedules, don't fire; a job brought back from the archive resumes at its next run from then.
- **Each run** posts "Scheduled run, Thu 8 Oct, 16:00" on the card, then:
  - **script mode** (the default) with a `run.sh`: replays `bash run.sh` in the job's sandbox without a model. Changed files in `outputs/` that are already deliverables on the job become their next versions; the last `SUMMARY:` line run.sh prints becomes the inbox line. If run.sh fails or is missing, its log goes on the thread and the agent is woken to fix it, rerun it and report.
  - **agent mode**, or no `run.sh` yet: the agent is woken and does the job, with the scheduled-run note as the newest thread entry.
- **Run script again**: a button in the Repeats panel replays run.sh the same way, on demand.
- A run that arrives while another is going is skipped with a note on the thread.
- Done doesn't stop a recurring job: the next run reopens it. Pause, Stop or Archive do.

## Memory

- **Job memory**: `NOTES.md`, kept by the agent (what each script does, how to rerun it, the parameters and results of every variant, decisions made). It is saved to the database after every run and read at the start of the next, along with the thread and summary.
- **Agent memory** for defined agents (preferences and lessons that carry across jobs) and the company profile and Brain sit above it *(agent memory: phase 2)*.

## Reruns

Agents structure code as config plus scripts plus one entry point (`run.sh`), so a new variant means changing the config. Scheduled runs and **Run script again** execute `run.sh` directly without a model call, and wake the agent only when the script fails or someone asks for a change.

## Agent tools

| Tool | What it does |
|---|---|
| `run_code` | Saves the code as a named script under `code/`, runs it (Python, Node or shell) and returns stdout, stderr, the exit code and the new or changed files in `outputs/`. The script is saved to the library as code. |
| `run_command` | Runs a shell command, e.g. `uv pip install --system yfinance`. |
| `read_file`, `write_file`, `list_files` | Work with files in the job folder or on the company drive (`/vercel/drive`). |
| `attach_file` | Attaches a file from the sandbox to the job as a deliverable (a new version if the job already has a file of that name). xlsx files are recalculated first so their values preview correctly. |
| `set_schedule`, `stop_schedule` | Make the job repeat (cron, timezone, script or agent mode), or stop it. |

## Phases

- **Phase 1 (built)**: sandbox per job with the template, the tools above, the file library with versions and inputs, Blob or Postgres storage, previews (xlsx sheets, images, CSV, markdown), a collapsed Code section, job memory, and Done vs Archived.
- **Phase 2 (built)**: recurring schedules with replayed `run.sh`, Run script again, and the company drive on Blob.
- **Phase 2 (next)**: long-running detached commands, auto-archive of one-off jobs, agent memory, per-agent sandboxes, and credential brokering for data APIs.

## Acceptance tests

1. **Simulation plus model.** "Run a Monte Carlo simulation of a 60/40 portfolio's one-year return (state your assumptions) and give me an xlsx model with the assumptions, results and a chart." Expect: a two-line inbox summary with the headline numbers; `portfolio-model.xlsx` with Assumptions, Simulation and Summary sheets (assumptions as input cells, formulas referencing them); a distribution chart; the simulation script under Code, which reproduces the numbers when rerun.
2. **Iterate on the same job.** Reply "use 70/30 instead". Expect: the same sandbox and scripts, the config changed, v2 of the xlsx next to v1, and a summary comparing the two.
3. **A new job on an existing file.** A new task with the model attached as an input. Expect: the file copied in, the result saved as the next version of the same file.
4. **No sandbox when not needed.** A research-only task starts no sandbox.
5. **Recurring job.** "Every weekday at 4pm, pull MU, NVDA and AMD closes, keep a history on the drive and chart the last month." Expect: a schedule on the card; run.sh that appends to the drive and redraws a fixed-name chart; at the next tick, a replay with no model call, the chart's next version and the SUMMARY line as the inbox line.
6. **Shared data.** A second job asked to analyse that history reads it from `/vercel/drive` instead of fetching it again.

## Decisions

1. Any agent can use a sandbox, created on first use.
2. One sandbox per job, kept until the job is archived (not per company: one company machine would let one runaway or compromised job take down or tamper with every other job, hit the 24-hour session limit constantly, and break per-agent permissions).
3. The base packages listed above.
4. Files in Vercel Blob (Postgres until a Blob store is connected), in a company library with versions.
5. xlsx files preview read-only in the app.
6. One-off jobs auto-archive after 30 days idle; recurring runs update the same card; scheduled reruns replay scripts and wake the agent only when needed.
7. The company data drive is Vercel Blob, synced into each sandbox at `/vercel/drive` (rather than a Sandbox Drive mount), so people and the app can read and upload the same files.
