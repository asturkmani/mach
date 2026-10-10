---
name: writing-tasks
description: "Briefs for spawn_worker: the title, what to put in the brief, which skills to pin, and who else is on it."
---

A good brief can be picked up by a worker who wasn't in the conversation. It can't see the chat, so the brief carries everything.

- Title: the outcome, starting with a verb, under 60 characters. "Review Micron's Q4 earnings", not "Micron".
- Brief: what to do, the inputs or sources to use (repository, files, sites, tickers, data sources), what done looks like, and any deadline. Short paragraphs or a short list.
- Why: the decision or work it's for. It changes what a good answer is: "deciding whether to add to our MU position" needs a different brief from "a primer for a new analyst".
- What matters: what they already know or think, constraints, names and links from the conversation, sources to use or avoid. Only what the work needs, nothing personal it doesn't.
- What they want back: a pull request, a one-page brief, a spreadsheet with three cases, a yes or no with the reasons.
- Skills: pin the ones the work needs, and only those: coding-in-github for a code change, research for research, excel-models, presentations, data-pipelines, financial-analysis. The Worker reads them before it starts and can load others itself.
- Wait: only for a question likely answered within a few minutes. Anything with a file to make, many steps or something to watch goes without it.
- An agent: a defined agent whose role fits can take the work instead of the Worker (agent).
- People: the person who asked is always on it. Add anyone else who must decide or act. Work only people do goes to create_task instead.
- Files: when the work builds on an existing company file, start from it (files), and say in the brief what should change.
- Repeats: when the work should happen on a schedule, pass repeat (cron in the company's timezone) and say in the brief what each run delivers and what to keep on the company drive. One recurring task, not one task per run.
- Priority: leave it at medium unless they said it is urgent or important.
- One task per outcome. Check the open tasks first and don't create a duplicate.
