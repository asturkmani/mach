# Pages

A page is a view of the company's data that people keep coming back to: net worth by entity, cash across banks, the pipeline. People ask the Chief of Staff for one; it builds it in the chat and keeps it up to date. Pages in the left menu opens the tabbed view (the page you looked at last); its chevron drops down every page and New page. Open pages sit in tabs across the top, remembered in your browser, with a "+" for a new page: describe it to the Chief of Staff or pick an idea.

## What a page reads

- **Mach1's own data, live.** `mach:tasks` (every open task and the latest 100 closed: status, priority, who's on it, dates, its url), `mach:people` (names, roles, reporting lines; no contact details) and `mach:agents`. They're read from the database each time the page opens, so they're always current and need no script or refresh job (`lib/mach-data.ts`; what each holds is in `lib/mach-sources.ts`). Links to a task's url open it in Mach1.
- **Integrations, through the drive.** A script calls the data source and saves a small file shaped for the page; a quiet job re-runs it on schedule. Pages don't call APIs as they open: that keeps them fast, keeps API calls (and their limits) to the schedule, and leaves a file other jobs can build on.
- **Any other file on the company drive** (JSON, CSV, text).

## How a page is made

1. **Data, by a script** (not needed for Mach1's own data). The Chief of Staff explores the data source with `call_api`, then writes a script on the company drive (`/vercel/drive/pages/<slug>/refresh.py`) that calls the API and writes a small JSON file shaped for the page (`/vercel/drive/pages/<slug>/data.json`). It runs it once in its workspace sandbox. Requests from the sandbox are signed by the network proxy, so the script never holds credentials.
2. **The page, as HTML.** `save_page` stores one HTML document that reads its drive files from `window.mach.data`. Every save is a new version; unchanged HTML adds none.
3. **A check.** After each save, the page's document (with its data) opens in the Chief of Staff's sandbox browser at desktop and phone widths. The model gets back script errors, blocked requests, a blank page or phone overflow, the headings, tables and charts it rendered, and the start of its text, and fixes what's wrong.
4. **Fresh data, quietly.** `refresh_page` sets up a recurring job (*Refresh page: …*) whose `run.sh` runs the script, and runs it once straight away. Its schedule is *quiet*: a run that works is noted on the job's thread and leaves it done, so it never lands in anyone's inbox. A run that fails wakes the job's agent to fix it, and what it reports reaches the people on the job. The page's header says when the data last changed and links to the job.

The `building-pages` skill is the playbook the Chief of Staff follows.

## Ideas

The new-page menu (and the Pages screen when no tabs are open) suggests up to four pages written for the company (`lib/page-ideas.ts`): a model reads the company profile, its integrations (and whether each is a connected data source or only a login), the files on its drive and the pages it already has. Ideas only use data a page can read: data sources and drive files. One that needs a system connected first says so, and picking it asks the Chief of Staff to connect it, then build the page. Ideas are kept in `page_ideas` until any of those inputs change, so the screen only waits for a model when something new happened (and streams them in after the list). Set `PAGE_IDEAS_MODEL` to use a cheaper model than the Chief of Staff's.

## How a page runs

`/pages/<slug>` shows a header (Refresh, Change, versions, pin, delete) over an iframe. The iframe's document comes from `/pages/<slug>/frame`, which puts Mach1's head in front of the page's own:

- **Mach1's look**: colour tokens for light and dark (including eight validated chart colours, `--series-1` to `--series-8`), type, and a few classes (`.stats`/`.stat`, `.table-wrap`, `.card`, `.grid`, `.label`, `.up`/`.down`, `.empty`). The app's theme setting is passed in.
- **`window.mach`**: `data` (each drive file by path: JSON parsed, CSV and text as text; Mach1's own data by name), `files` (each one's last change and any problem), and helpers: `csv`, `money`, `number`, `percent`, `ago`, `file`, `open`.
- **Links**: the frame can't navigate the app, so a click on a link to one of the app's own paths (`/tasks/12`) is passed to the app (`postMessage`), which opens it if it's one of its own paths.

The frame is locked down two ways:

- The iframe has `sandbox="allow-scripts"`, and the route sends a `Content-Security-Policy` with `sandbox allow-scripts`, so the page has an opaque origin even if opened directly: no Mach1 cookies, storage or access to the app around it.
- The policy allows no connections (`connect-src 'none'`), no forms and no images from the web. Scripts may come only from `cdn.jsdelivr.net` (pinned chart libraries) and inline; styles and fonts from Google Fonts.

So a page can only draw what it was handed. A page's script could still navigate its own frame away, so the data a page is given should be what the people who can see it may see, nothing more.

## Limits

- HTML up to 1 MB; data goes in drive files, not in the page.
- Up to 20 drive files and 8 MB of data per page. JSON and text files only.
- Deleting a page keeps its data on the drive and archives its refresh job.

## Where it lives

| Path | What |
| --- | --- |
| `lib/pages.ts` | Pages and their versions, their data, and the refresh job |
| `lib/mach-data.ts`, `lib/mach-sources.ts` | Mach1's own data pages read live |
| `lib/page-frame.ts` | The frame's document (kit, `window.mach`) and its policy |
| `lib/agents/page-tools.ts`, `page-steps.ts` | `save_page`, `read_page`, `refresh_page`, and the browser check |
| `lib/page-ideas.ts` | Ideas for pages, per company, cached until its inputs change |
| `app/(app)/pages/` | The list, a page, the frame route, and their actions |
| `components/page-view.tsx`, `page-tabs.tsx`, `pages-list.tsx` | The page screen, Home's tabs, the list's controls |
| `lib/schedules.ts` (`quiet`), `lib/agents/schedule-steps.ts` | Quiet recurring jobs |
