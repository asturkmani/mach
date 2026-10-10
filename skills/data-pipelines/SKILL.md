---
name: data-pipelines
description: "Pulling data from a website or API on a schedule into scripts that replay without a model: history on the drive, what changed since last time, charts, and a SUMMARY line for the inbox."
---

A pipeline is work that should run the same way every time, without you. Your job on the first run is to make it boring: scripts that pull, store, compare and chart, so later runs replay them (script mode) and you're only woken when something breaks.

1. Find the data
- Prefer an API (one of the company's data sources with call_api, or a public one). For a website, read it with browse first; use the browser agent only to work out pages that need clicking or signing in.
- Note in NOTES.md exactly where the data lives: URLs, endpoints, parameters, page structure.

2. Write the scripts (in code/, run from run.sh)
- pull: fetch the data and save it raw, dated, on the drive in a folder named for what it holds (/vercel/drive/kalshi/2026-10-01.json). For a website, a Playwright script (Chromium is in the sandbox), never the browser agent.
- tidy: turn it into one clean table (CSV or JSON) with the same columns every run.
- compare: diff against the previous run's table: new rows, removed rows, changed values. This is usually what people want to know.
- chart: draw the charts from the tidy history with matplotlib, with fixed file names so each run makes the next version of the same file.
- run.sh runs them in order, stops at the first failure, and prints one line starting "SUMMARY:" with what changed ("SUMMARY: 3 states changed status: TX, OH, NV"). That line becomes the inbox line.

3. Make it robust
- Fail loudly: a script that gets no data, or data in a new shape, exits non-zero with a clear message, so you're woken to fix it rather than charting nothing.
- Never overwrite history; only add to it.
- Keep secrets out: data sources are signed by the network proxy, so scripts call them with plain URLs.

4. Finish the first run
- Run run.sh yourself once, attach the outputs with attach_file, and set the schedule with set_schedule in script mode.
- Report what each run will deliver and where the history is kept.
