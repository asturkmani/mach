# Pages

A page is a view of the company's data that people keep coming back to: net worth by entity, cash across banks, the pipeline. People ask the Chief of Staff for one; it builds it in the chat and keeps it up to date. Pinned pages are tabs on Home, next to the work.

## How a page is made

1. **Data, by a script.** The Chief of Staff explores the data source with `call_api`, then writes a script on the company drive (`/vercel/drive/pages/<slug>/refresh.py`) that calls the API and writes a small JSON file shaped for the page (`/vercel/drive/pages/<slug>/data.json`). It runs it once in its workspace sandbox. Requests from the sandbox are signed by the network proxy, so the script never holds credentials.
2. **The page, as HTML.** `save_page` stores one HTML document that reads its drive files from `window.mach.data`. Every save is a new version; unchanged HTML adds none.
3. **A check.** After each save, the page's document (with its data) opens in the Chief of Staff's sandbox browser at desktop and phone widths. The model gets back script errors, blocked requests, a blank page or phone overflow, the headings, tables and charts it rendered, and the start of its text, and fixes what's wrong.
4. **Fresh data, quietly.** `refresh_page` sets up a recurring job (*Refresh page: …*) whose `run.sh` runs the script, and runs it once straight away. Its schedule is *quiet*: a run that works is noted on the job's thread and leaves it done, so it never lands in anyone's inbox. A run that fails wakes the job's agent to fix it, and what it reports reaches the people on the job. The page's header says when the data last changed and links to the job.

The `building-pages` skill is the playbook the Chief of Staff follows.

## How a page runs

`/pages/<slug>` shows a header (Refresh, Change, versions, pin, delete) over an iframe. The iframe's document comes from `/pages/<slug>/frame`, which puts Mach's head in front of the page's own:

- **Mach's look**: colour tokens for light and dark (including eight validated chart colours, `--series-1` to `--series-8`), type, and a few classes (`.stats`/`.stat`, `.table-wrap`, `.card`, `.grid`, `.label`, `.up`/`.down`, `.empty`). The app's theme setting is passed in.
- **`window.mach`**: `data` (each drive file by path: JSON parsed, CSV and text as text), `files` (each path's last change and any problem), and helpers: `csv`, `money`, `number`, `percent`, `ago`, `file`.

The frame is locked down two ways:

- The iframe has `sandbox="allow-scripts"`, and the route sends a `Content-Security-Policy` with `sandbox allow-scripts`, so the page has an opaque origin even if opened directly: no Mach cookies, storage or access to the app around it.
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
| `lib/page-frame.ts` | The frame's document (kit, `window.mach`) and its policy |
| `lib/agents/page-tools.ts`, `page-steps.ts` | `save_page`, `read_page`, `refresh_page`, and the browser check |
| `app/(app)/pages/` | The list, a page, the frame route, and their actions |
| `components/page-view.tsx`, `page-tabs.tsx`, `pages-list.tsx` | The page screen, Home's tabs, the list's controls |
| `lib/schedules.ts` (`quiet`), `lib/agents/schedule-steps.ts` | Quiet recurring jobs |
