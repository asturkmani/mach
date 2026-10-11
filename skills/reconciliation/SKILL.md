---
name: reconciliation
description: "Going through many items against their history (tagging transactions, matching payments, sorting entries to people): code works out the facts, mach.decide makes the judgment calls, the rest goes to people with suggestions, and a ledger keeps track."
---

For work that's a loop of small decisions over many items: which tag, which entity, is this a repeat, who should look at it. Done well, most items are settled without anyone, the rest reach the right person with a suggestion filled in, and nothing is done twice.

Steps, in scripts
1. Pull the items and the options fresh each run (the tag list from the system, the entities from the skill or the profile). Never write options into a script.
2. For each item, code works out the facts, as plain statements: the counterparty seen before (and how often), the amount against its history ("matches the last three payments"), how often it recurs ("monthly, last paid 3 Sept"). Decision models are weak at comparing numbers and dates; code isn't.
3. Ask mach.decide the judgment calls, several at once, with the item's key (the counterparty) and the target the skill sets (e.g. 0.98):
   answers = mach.decide(skill=..., state=facts, questions={...}, key=counterparty, target=0.98)
4. Items whose answer comes back auto are decided: nobody needs to choose for them. auto is only true when a backtest on people's past answers says answers this sure are right that often; until there's enough history, nothing is automatic.
5. Everything else goes to people, routed by the skill's rules, each with the suggestion and how sure it is, so they confirm or change rather than start from blank.
6. Record every person's answer with mach.outcome(id, final, by). That's the history the next run learns from, and what the backtest measures.

Rules
- One ledger per run, in the job's folder (ledger.csv: item, decision, by, when, done), written as you go, so a retry carries on instead of repeating.
- Writes to a system of record need an approval of the exact list first: the decided items and the ones people confirmed, in one request_approval (a numbered list, or a file with them). Without it, the system refuses the write.
- Apply only what was approved. In a script, read the list with mach.approved() and skip the items it says are done; with call_api, give each write its approval and item. Report what was applied.
- Keep "none of these" as a real answer: it goes to a person.

Checks
- Count in, count out: every item is applied, sent to someone, or reported as skipped.
- The ledger matches what the system now shows.
