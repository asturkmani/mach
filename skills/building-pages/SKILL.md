---
name: building-pages
description: "Building a page: a report on company data (a dashboard) in Pages that stays up to date."
tools: [save_page, read_page, refresh_page, share_page]
---

A page is a view of the company's data that people keep coming back to (net worth by entity, cash across banks, the pipeline), in Pages. Build one when someone asks for a dashboard, a view or a page, or to "see X every morning". A one-off question needs an answer, not a page.

Only build a page on real data. If the data isn't available (the system isn't connected, there are no files for it), don't build a placeholder page, write "pending" data or schedule a refresh: tell them what's needed (connect the bank or Masttro, or upload a file) and offer to do that first.

How a page works:
- Its data is files on the company drive (/vercel/drive), and Mach1's own data. The page is one HTML document that reads them from window.mach.data, keyed by what you listed in save_page's data: a drive path ("pages/net-worth/data.json") arrives parsed, CSV and text as text (mach.csv(path) turns CSV into objects).
- Mach1's own data is read live each time the page opens, with no script or refresh job: list it by name in data.
{{mach_sources}}
  For a page of the company's work (open tasks by person, what's overdue, what agents are doing), use mach:tasks and mach:people, not a script. Link a task with its url (an <a href> to /tasks/12): it opens in Mach1.
- It can't fetch anything (no fetch, no API calls, no images from the web): it runs sandboxed with no network. Everything it shows comes from its files.
- Keep data and page apart: a script makes the data, the page only draws it. Shape the data for the page (a small JSON with exactly what it shows: totals, rows, series, and an as_of time), not a raw API dump.

Steps:
1. Get the data (skip this for a page that only reads Mach1's own data). If it lives in a system that isn't one of the company's data sources yet (say Masttro, with only a docs login connected), stop and say so with ask: their Chief of Staff connects it with them, and you carry on once it's there. From a data source: explore it with call_api (small requests), then write a script on the drive, /vercel/drive/pages/<slug>/refresh.py, that calls the API and writes /vercel/drive/pages/<slug>/data.json. Call the API at its normal URL with plain requests; Mach1 signs requests from the sandbox, so never put credentials in code. Run it (run_command: python3 /vercel/drive/pages/<slug>/refresh.py) and read the file back to check its shape. From data already on the drive, read it and, if it's big, write a smaller summary file for the page.
2. Write the page with save_page, a whole HTML document:
   - Mach1's look comes with it. Use its CSS variables (--ink, --muted, --faint, --line, --raised, --panel, --accent, --up, --down, --series-1 to --series-8) and classes: .label (small uppercase label), .stats holding .stat blocks (each with .label, .value and .note) for headline numbers, .table-wrap around a table (th.num and td.num right-align numbers), .card, .grid, .row, .stack, .muted, .up, .down, .empty. Don't restyle the body or load other fonts; light and dark mode then work by themselves.
   - Helpers: mach.money(value, "USD"), mach.number(value), mach.percent(0.123) gives "12.3%", mach.ago(date), mach.file(path).updatedAt, mach.csv(path).
   - Plain JavaScript in a script at the end of the body that builds the page from mach.data. When a file is missing (mach.data[path] is undefined), show an .empty block saying the data isn't there yet.
   - Lead with what matters: three to five headline numbers, then the main table or chart, then detail. Say when the data is from ("Data as of 07:02").
   - Mach1 shows the page's title above it: don't repeat it as a heading. Keep it calm: no coloured side borders, banners or gradients; notes go in .muted text.
   - Charts: bars made of divs, or inline SVG, are usually enough. For more, load one library with an exact version from https://cdn.jsdelivr.net/npm/ (Observable Plot or Chart.js). Use the --series colours in order, label the values, one axis per chart.
   - It must work on a phone: tables in .table-wrap, rows that wrap.
   - Keep data out of the HTML (it has a 1 MB limit).
3. save_page checks the page in your sandbox browser: fix any script errors, a blank page or overflow, and save again.
4. To keep it fresh, call refresh_page with the command from step 1 and a schedule in their timezone ("every weekday at 7am" is 0 7 * * 1-5). If they didn't say how often, data that changes daily refreshes each weekday morning. Runs are quiet; only failures reach people.
5. Report in a line or two what it shows, with the page's link (save_page gives it): it's in Pages, private to them until they share it.

Changing a page later: read_page, then save_page with page set to its slug, the whole new HTML and a short note on what changed. Every version is kept, and people can go back to an earlier one.
