# Private and company work

Everything people make in Mach1 belongs to whoever made it, and everyone in
the company sees only what's been shared. It works like Notion's private and
workspace pages, or files on your own computer vs the shared drive.

| | Private: who sees it | Shared with the company |
| --- | --- | --- |
| **Task** | Whoever created it, the people on it, anyone @-mentioned on it | Everyone |
| **File** in the library | Its owner (who added it in their chat), and whoever can see a task it's on | Everyone |
| **Page** | Whoever made it (its refresh job follows the page) | Everyone |

- **New work is private.** A task someone creates (New task, or by asking the Chief of Staff), the files its agents make, and the pages someone asks for. New task has a *Share with the company* checkbox, and the Chief of Staff shares work that's clearly meant for everyone (a family report). Work from before this stays company work.
- **Sharing** is a switch on the task, the file (Files page) or the page, or saying so to the Chief of Staff (`share_task`, `share_page`). Whoever made it, or an admin, can change it. Sharing a task shares its files; sharing a page shares its refresh job. To share a task with one person, put them on it or mention them.
- **One rule everywhere.** Home, the board and list, search, the task page and its actions, the Files page, downloads and previews, pages and their frames, the menu, and the Chief of Staff's overview and tools all ask the same question: may this person see it? (`visibleTo` in `lib/tasks.ts`, `fileVisibleTo` in `lib/files.ts`, `pageVisibleTo` in `lib/pages.ts`). Internal work (agent runs, schedules) sees everything it needs.
- **Pages read company work only.** `mach:tasks` lists company tasks, since a page can be shared with everyone.
- **Private tasks' data.** Agents on a private task keep its data in the job's own folder, not on the company drive, which every job shares.
- **Integrations.** Each one can be limited to chosen people (Settings → Integrations → Whose work, for admins): only their assistant, and runs working for them, can use it.
- **When someone leaves**, what they shared passes to the admin who removed them (`handOverShared`), so shared jobs and pages keep an owner. Their private things stay theirs, which no one can see. Their own sandbox is deleted and their GitHub grant revoked.

Not yet: a personal folder on the drive (`/me`, synced to their own sandbox), and sharing with specific people outside tasks.
