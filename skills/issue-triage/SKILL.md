---
name: issue-triage
description: "Before fixing GitHub issues: finding the right ones, dropping duplicates and non-bugs, and reproducing each with a failing test so the fix can be proved."
---

Fixing the wrong issue, or fixing a bug you never saw, wastes everyone's time. Triage first.

1. Find them
- List the issues with github_api (GET /repos/OWNER/REPO/issues?state=open&since=..., newest first). Pull requests also come back from that endpoint: skip anything with a pull_request field.
- Read each one fully, comments included.

2. Sort them
- Duplicates: the same failure reported twice. Keep the clearest one and note the others.
- Not a bug: questions, feature requests, things working as designed. Leave them, and say so in the report.
- Not enough to go on: no steps, no error. Note what's missing rather than guessing.
- What's left are the issues to fix. If there are more than one or two and they're independent, they're better fixed in parallel: say so (escalate) rather than doing them one after another.

3. Reproduce before fixing
- For each issue, write a test that fails for the reason the issue describes, using the repository's own test setup (coding-in-github has the rest of the steps). Run it and see it fail.
- If you can't make it fail, don't fix anything: report what you tried.

4. Then fix, and prove it
- The test from step 3 now passes, and the repository's other checks still pass.
- In the pull request, link the issue ("Fixes #123") and say how the test reproduces it.
