# Sandboxes and files for coding and analysis jobs

**Status: decided 2026-10-07. Phase 1 is being built; phase 2 follows.**

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
  - **Recurring** ("every weekday at 4pm, chart today's option flow"): a schedule on the card; each run's result lands in the inbox as an update on the same card. *(phase 2)*

## Sandboxes

- **One sandbox per job**, named after the task (`mach-task-<id>`), created the first time an agent on the job runs code. Any agent can use one; agents that never run code never start one.
- **Kept until the job is archived.** It is stopped at the end of every run (Vercel saves the filesystem) and resumed by name on the next run, so scripts, installed packages and downloaded data are where the agent left them.
- **Base setup**: every job sandbox starts from a company-wide template with the data stack installed: Python 3.14 with pandas, numpy, scipy, statsmodels, scikit-learn, numpy-financial, openpyxl, xlsxwriter, matplotlib, seaborn, pyarrow, duckdb, requests, httpx, beautifulsoup4, python-docx, python-pptx and tabulate; LibreOffice (to recalculate xlsx formulas so models can be checked and previewed); Node 24; and uv for anything else. The template is built once and snapshotted.
- **Layout** inside the sandbox: `/vercel/job/code` (scripts), `/vercel/job/inputs` (files attached to the job), `/vercel/job/outputs` (deliverables), and `/vercel/job/NOTES.md` (job memory).
- **Limits**: 2 vCPUs and 4 GB per sandbox; a single command runs for at most 4 minutes in phase 1. Longer jobs run detached and the workflow checks on them between steps *(phase 2)*.
- **Safety**: no secrets in the sandbox; no environment variables are passed in and model calls happen outside it (SBX-5). Network egress is open and logged. Credentials for data APIs (an options feed) are added to outgoing requests at the network layer by Vercel Sandbox's request transformations, never stored inside *(phase 2)*.
- **Later**: a **company data drive** (Vercel Sandbox Drives) mounted read-only into every job sandbox for shared datasets, and an optional **sandbox per defined agent** for specialist agents that accumulate their own data *(phase 2)*.

## Files: the company library

- Every file an agent attaches, and every script it runs, goes into the **company file library** with **versions**: name, kind (deliverable or code), and for each version its size, type, which task and agent produced it, and which version it was built from.
- **Storage** is Vercel Blob (private) when a Blob store is connected to the project, and Postgres otherwise; the app reads both. Downloads go through Mach, which checks the person is in the company.
- A job's **inputs** are library files attached to it, by a person on the task page or by the Chief of Staff when it creates the job. They are copied into the sandbox's `inputs` folder when the run starts. Saving a file with the same name as one of the job's files makes a **new version of that file**, not a new file.
- If two jobs edit the same version at once, both versions are kept and the later one notes which version it was built from.
- Sandboxes are scratch space, not the system of record: if a sandbox is lost, a fresh one is rebuilt from the library (inputs, deliverables, code) and the job's notes.

## Memory

- **Job memory**: `NOTES.md`, kept by the agent (what each script does, how to rerun it, the parameters and results of every variant, decisions made). It is saved to the database after every run and read at the start of the next, along with the thread and summary.
- **Agent memory** for defined agents (preferences and lessons that carry across jobs) and the company profile and Brain sit above it *(agent memory: phase 2)*.

## Reruns *(phase 2)*

Agents structure code as config plus scripts plus one entry point (`run.sh`), so a new variant means changing the config. Scheduled runs and a **Run again** button execute `run.sh` directly without a model call, and wake the agent only when the script fails, the output looks wrong, or someone asks for a change.

## Agent tools (phase 1)

| Tool | What it does |
|---|---|
| `run_code` | Saves the code as a named script under `code/`, runs it (Python, Node or shell) and returns stdout, stderr, the exit code and the new or changed files in `outputs/`. The script is saved to the library as code. |
| `run_command` | Runs a shell command, e.g. `uv pip install --system yfinance`. |
| `read_file`, `write_file`, `list_files` | Work with files in the sandbox. |
| `attach_file` | Attaches a file from the sandbox to the job as a deliverable (a new version if the job already has a file of that name). xlsx files are recalculated first so their values preview correctly. |

## Phases

- **Phase 1 (now)**: sandbox per job with the template, the tools above, the file library with versions and inputs, Blob or Postgres storage, previews (xlsx sheets, images, CSV, markdown), a collapsed Code section, job memory, and Done vs Archived.
- **Phase 2**: recurring schedules and replayed `run.sh` reruns, long-running detached commands, auto-archive of one-off jobs, the company data drive, agent memory, per-agent sandboxes, and credential brokering for data APIs.

## Acceptance tests

1. **Simulation plus model.** "Run a Monte Carlo simulation of a 60/40 portfolio's one-year return (state your assumptions) and give me an xlsx model with the assumptions, results and a chart." Expect: a two-line inbox summary with the headline numbers; `portfolio-model.xlsx` with Assumptions, Simulation and Summary sheets (assumptions as input cells, formulas referencing them); a distribution chart; the simulation script under Code, which reproduces the numbers when rerun.
2. **Iterate on the same job.** Reply "use 70/30 instead". Expect: the same sandbox and scripts, the config changed, v2 of the xlsx next to v1, and a summary comparing the two.
3. **A new job on an existing file.** A new task with the model attached as an input. Expect: the file copied in, the result saved as the next version of the same file.
4. **No sandbox when not needed.** A research-only task starts no sandbox.

## Decisions

1. Any agent can use a sandbox, created on first use.
2. One sandbox per job, kept until the job is archived (not per company: one company machine would let one runaway or compromised job take down or tamper with every other job, hit the 24-hour session limit constantly, and break per-agent permissions).
3. The base packages listed above.
4. Files in Vercel Blob (Postgres until a Blob store is connected), in a company library with versions.
5. xlsx files preview read-only in the app.
6. One-off jobs auto-archive after 30 days idle; recurring runs update the same card; scheduled reruns replay scripts and wake the agent only when needed.
