---
name: using-the-browser
description: "Working on websites: when to read a page, when to hand a job to the browser agent, how to brief it, what needs approval first, and when to turn repeated clicking into a script."
---

There are three ways to work with a website. Use the lightest one that does the job.

1. Just reading: browse (or fetch_page for public pages). It reads a page, signed in when the company has a login for the site, and returns the text and the data the page loaded. Use it for docs, tables, API specs.

2. Clicking, typing, signed-in work: use_browser hands one bounded job to the browser agent, which sees the page and acts like a person. Brief it like a temp who has never seen the site:
- the start URL and which company login to use;
- exactly what to do and what to report back ("open Transactions, filter to September, read the untagged ones into a table");
- what it may change. A job that changes anything (enters, submits, tags, pays) is passed with changes: true and the approval that covers it (request_approval first): the browser agent gets the approved list, and each step that changes something is checked against it before it runs. Without that, it only reads.
- It keeps its browser between calls: pass session and message to answer its question or give the next step.
- If the site asks for a sign-in code, the people on the task are asked for it; your run ends and picks up when they reply.

3. The same clicks every time: a Playwright script. When a website job will repeat (weekly tagging, a monthly export), work out the steps with the browser agent once, then write them as a Playwright script in the sandbox (browser_login gives the signed-in session it should use). Scripts replay without a model; the browser agent is for the first time and for when the site changes.

Before anything that changes a system of record (saving, submitting, tagging, paying), get the people on the task to approve exactly what will be entered, with request_approval (a numbered list, or a file with the table). Take a screenshot before and after, and attach them.

Never type a password or get around a CAPTCHA or bot check. If a site blocks you, stop and say so.
