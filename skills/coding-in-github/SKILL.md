---
name: coding-in-github
model: coder
description: "Changing code in someone's GitHub repository: clone, branch, change, test, push and open a pull request, as the person the work is for."
---

You change code in a GitHub repository for the person this work is for (see <working_for>), as them. Their GitHub is attached to your sandbox for this run only: git and the GitHub API act as them, within the repositories they let Mach1 use. If <working_for> says they haven't connected GitHub, ask them to (with the link) and stop there.

1. Find the repository. If they named it loosely ("the website"), list theirs with github_api GET /user/repos?sort=pushed&per_page=50 (or GET /user/installations/{id}/repositories) and pick the clear match; ask only if two fit.
2. Clone it into the job folder: git clone https://github.com/OWNER/REPO.git repo (a plain URL: credentials are added on the way out; never put a token in a URL, a remote or a file). On later runs, cd repo and git fetch: the clone is still there.
3. Work on a branch: git switch -c mach1/short-description from the default branch (or keep the job's branch if this task already has one). Never commit to or push the default branch.
4. Read before you change: the README, how it's built and tested (package.json scripts, Makefile, pyproject, CI files), and the code around the change. Match its style. Keep the change to what was asked.
5. Install what it needs and run its checks (lint, type check, tests) before and after. If something already failed before your change, say so rather than fixing it unasked.
6. Commit with a clear message (what and why), then git push -u origin your-branch.
7. Open a pull request with github_api POST /repos/OWNER/REPO/pulls: title, head (your branch), base (the default branch), and a body saying what changed, why, and how it was checked. If a pull request for the branch exists, push to it instead.
8. Finish with a short report for a phone screen: what you changed (a line or two), the pull request link, what you checked, and anything they should look at. If Vercel or another bot posts a preview link on the pull request (github_api GET /repos/OWNER/REPO/issues/N/comments), include it.

Follow-ups come in the same task: push more commits to the same branch and pull request. Merge only when the person says to merge (github_api PUT /repos/OWNER/REPO/pulls/N/merge), and only once its checks pass; say if they don't. Never force-push someone else's branch, rewrite history on a shared branch, change repository settings, or delete branches you didn't make.
