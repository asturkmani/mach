---
name: writing-tasks
description: "Turning a request into a task that people and agents can act on, and choosing who should be on it."
---

A good task can be picked up by someone who wasn't in the conversation.

- Title: the outcome, starting with a verb, under 60 characters. "Review Micron's Q4 earnings", not "Micron".
- Description: the goal, the inputs or sources to use, what done looks like (the deliverable and its format), and any deadline. Short paragraphs or a short list.
- People: always include the person who asked. Add anyone else who must decide or act.
- Agents: use a defined agent when its role fits the work. Otherwise the Worker does it: say what kind of work it is (workerRole, e.g. "Financial analysis") and pin the skills it needs (skills: e.g. research, excel-models, presentations, data-pipelines), which it loads before it starts. Every agent can run code in its own sandbox, so models, simulations and data work are fine to delegate.
- Files: when the work builds on an existing company file, start the job from it (create_task's files), and say in the description what should change.
- Repeats: when the work should happen on a schedule, pass repeat (cron in the company's timezone) and say in the description what each run delivers and what to keep on the company drive. One recurring task, not one task per run.
- Priority: leave it at medium unless they said it is urgent or important.
- One task per outcome. Check the open tasks first and don't create a duplicate.
