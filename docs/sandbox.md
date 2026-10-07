# Sandboxes for coding and analysis jobs (v1)

**Status: draft for discussion. Nothing here is built yet; the open decisions are at the end.**

Builds on [F5.4 Sandbox](spec.md#f54-sandbox) in the product spec. Where this plan differs from F5.4, it says so.

## Goal

Agents that need to compute something — a financial model, a simulation, a data clean-up, a script — write and run code in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) and hand back real files: an `.xlsx` model with working formulas, CSVs, charts. The code they ran is attached too, so anyone can check or rerun it, but it sits behind the deliverables rather than in front of them.

## What the person sees

1. They ask the Chief of Staff (or create a task) as today: "Run a Monte Carlo simulation of our 60/40 portfolio over one year and give me an xlsx model."
2. The task comes back to their inbox: *"Median 1-year return is 6.1%, with a 5% chance of losing more than 12%. Model attached. Share it with the family?"*
3. On the task page:
   - **Files** (front and centre): `portfolio-model.xlsx` with a preview of its sheets and a download button, `return-distribution.png` shown inline, any CSVs as tables.
   - **Code** (collapsed, one click away): `simulation.py` and `build_model.py`, syntax highlighted, each with the output of its last run. Download as a zip.
   - The thread, summary and options as now.

## How it works

### Who gets a sandbox

Any agent can use one; it is created the first time the agent calls a code tool, so agents that never run code cost nothing. Worker agents with a data or coding role, and defined agents made from the Financial analyst or Coder templates, are told in their instructions to use it for any calculation.

### One sandbox per task

The sandbox is named after the task (`mach-task-<id>`), so every run on that task — the first run, and the run after someone replies "use 7% growth instead" — finds the same files and scripts and just edits them. It stops when the run ends (Vercel keeps its filesystem), and it is deleted when the task closes.

*F5.4 proposes one persistent sandbox per agent. Per task keeps files from different jobs apart and lets one defined agent work several tasks at once; the agent-level image still gives every task the same tools.*

### The image

A custom image, built from `sandbox/Dockerfile` in this repo and pushed to Vercel Container Registry, so the base packages are already installed when a sandbox boots:

- **Python 3.14** with pandas, numpy, scipy, statsmodels, scikit-learn, numpy-financial, openpyxl, xlsxwriter, matplotlib, seaborn, pyarrow, duckdb, requests, httpx, beautifulsoup4, python-docx, python-pptx, tabulate.
- **Node 24** with pnpm, for coding jobs.
- uv for anything else the agent installs at run time.

Fallback while the image isn't built: Vercel's `python:3.14` image with the same packages installed on first boot (slower first run, about a minute).

### Agent tools

| Tool | What it does |
|---|---|
| `run_code` | Saves the code as a named script under `/workspace/code`, runs it (Python, Node or shell) with a time limit, and returns stdout, stderr, the exit code and which files in `/workspace/outputs` are new or changed. |
| `run_command` | Runs a shell command, e.g. `uv pip install yfinance`. |
| `read_file`, `write_file`, `list_files` | Work with files in the sandbox. |
| `attach_file` | Attaches a file from `/workspace/outputs` to the task as a deliverable. |

When the run finishes, every script under `/workspace/code` that ran is attached automatically as **code**, so the person can always see how a number was produced. Today's `save_output` stays for small text files written directly.

### Files

Binary files (xlsx, png) can't live in the `task_outputs` text column, so attachments move to **Vercel Blob** (private), with a row per file in Postgres: task, kind (deliverable or code), name, size, content type, blob URL, which agent and run produced it. Downloads go through our own route, which checks the person is in the company before streaming the file. Previews: xlsx sheets are read on the server and shown as tables (first 200 rows per sheet); images inline; CSV and markdown as today.

### Durable runs

Each sandbox action is a Workflow step, so a crash mid-run resumes without redoing finished work. The `Sandbox` object crosses step boundaries natively. A single command is limited to a few minutes inside a step; longer jobs (large simulations, data pulls) run detached, and the workflow checks on them with `sleep()` between steps, so they can run for hours without holding a function open.

### Safety and cost

- **No secrets in the sandbox.** No environment variables are passed in; model calls happen outside it (F5.4 SBX-5).
- Network egress is open in v1 (pip installs, public data) and logged; per-agent allowlists come later (SBX-4).
- Limits per task: 2 vCPUs, 10 minutes of runtime per agent run, 1 hour per task, adjustable per agent.
- The run shows sandbox time used, so we can see cost per job.

## Acceptance tests

1. **Simulation plus model.** "Run a Monte Carlo simulation of a 60/40 portfolio's one-year return (state your assumptions) and give me an xlsx model with the assumptions, results and a chart." Expect: a two-line inbox summary with the headline numbers; `portfolio-model.xlsx` with Assumptions, Simulation and Summary sheets (assumptions as input cells, formulas referencing them); a distribution chart; `simulation.py` under Code, which reproduces the numbers when rerun.
2. **Follow-up reuses the sandbox.** Reply "use 70/30 instead". Expect: the same scripts edited, a new version of the xlsx, a new summary.
3. **Micron model in Excel.** The earlier Micron request, now delivered as an xlsx with live formulas (revenue drivers flow into EPS) plus the Python that built it.
4. **No sandbox when not needed.** A research-only task creates no sandbox.

## Open decisions

1. **Who gets a sandbox.** Every agent, created on first use (recommended), or only agents with a data or coding role?
2. **Scope.** One sandbox per task (recommended), or one per agent as F5.4 says today?
3. **Base packages.** Anything to add to the list above, e.g. yfinance, QuantLib, R?
4. **File storage.** Vercel Blob (recommended; needs a Blob store added to the Vercel project), or keep files in Postgres?
5. **xlsx preview.** Read-only sheet preview in the app (recommended), or download only?
