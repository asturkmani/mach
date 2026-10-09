"use client";

import { MessageSquare, RotateCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

import { deletePageAction, refreshPageAction, restorePageAction, setPageVisibilityAction } from "@/app/(app)/pages/actions";
import { VisibilityToggle } from "@/components/kit";
import { CosToggle } from "@/components/shell/cos-toggle";
import { PageTabs } from "@/components/page-tabs";
import { startCosMessage, useShell } from "@/components/shell/shell";
import { When } from "@/components/ui";
import type { PageIdea } from "@/lib/page-ideas";

// A page: a header that says how fresh its data is and who keeps it fresh,
// over the page itself in a sandboxed frame. The frame's document comes from
// /pages/[slug]/frame, which only scripts may run in and nothing may connect from.

type FileStatus = { path: string; live: boolean; updatedAt: string | null; problem: string | null };
type Refresh = { number: number; running: boolean; schedule: string | null; lastRunAt: string | null; failing: boolean };

export function PageView({
  page,
  viewing,
  files,
  versions,
  refresh,
  ideas,
}: {
  page: {
    slug: string;
    title: string;
    description: string;
    version: number;
    visibility: "company" | "private";
    /** The signed-in person may change who sees it (they made it, or they're an admin). */
    canShare: boolean;
  };
  /** An older version being looked at, or null for the latest. */
  viewing: number | null;
  files: FileStatus[];
  versions: { version: number; note: string; byName: string; createdAt: string }[];
  refresh: Refresh | null;
  /** Ideas for new pages, in the "+" menu at the end of the tabs. */
  ideas: PageIdea[];
}) {
  const router = useRouter();
  const { theme, toast, setCosOpen } = useShell();
  const [pending, startTransition] = useTransition();
  const frame = useRef<HTMLIFrameElement>(null);

  // A link in the page (a task's url, another page) asks to open it here: only the app's own paths are followed.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const { type, path } = (event.data ?? {}) as { type?: string; path?: unknown };
      if (type === "mach:open" && typeof path === "string" && /^\/(?!\/)[\w\-/?=&.%#]*$/.test(path)) router.push(path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  const run = (work: () => Promise<{ error?: string }>, done?: string) =>
    startTransition(async () => {
      const result = await work();
      if (result.error) toast(result.error);
      else if (done) toast(done);
    });

  // The frame reloads when the data or the version changes.
  const stamp = files.map((f) => f.updatedAt ?? "").join("|");
  const query = new URLSearchParams();
  if (theme !== "system") query.set("theme", theme);
  if (viewing) query.set("v", String(viewing));
  query.set("d", String(stamp.length ? hash(stamp) : 0));
  const src = `/pages/${page.slug}/frame?${query}`;

  const dated = files.filter((f) => f.updatedAt).map((f) => f.updatedAt!);
  const oldest = dated.length ? dated.reduce((a, b) => (a < b ? a : b)) : null;
  const missing = files.filter((f) => f.problem);
  const button = "flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] hover:bg-hover hover:text-ink disabled:opacity-50";

  return (
    <>
      <PageTabs current={page.slug} ideas={ideas} />

      {/* One slim bar under the tabs: what the page reads and how fresh it is, then what you can do with it. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-1.5 text-xs text-muted sm:px-8">
        {page.description && <span className="min-w-0 truncate">{page.description}</span>}
        {files.length > 0 && (
          <span title={files.map((f) => (f.live ? `${f.path} (live)` : `/vercel/drive/${f.path}`)).join("\n")}>
            {files.every((f) => f.live) ? "Live data from Mach1" : <>Data {oldest ? <When date={oldest} /> : "not there yet"}</>}
          </span>
        )}
        {refresh ? (
          refresh.failing ? (
            <Link href={`/tasks/${refresh.number}`} className="text-warn hover:underline">
              The last refresh failed: it&apos;s being fixed on #{refresh.number}
            </Link>
          ) : (
            <Link href={`/tasks/${refresh.number}`} className="hover:text-ink">
              Refreshed by #{refresh.number}
              {refresh.schedule ? ` · ${refresh.schedule}` : ""}
            </Link>
          )
        ) : (
          files.some((f) => !f.live) && <span>Not refreshed on a schedule</span>
        )}
        {missing.length > 0 && (
          <span className="text-warn">
            {missing.map((f) => `${f.path}: ${f.problem}`).join(" · ")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1 text-muted">
          <span className="px-2">
            <VisibilityToggle
              visibility={page.visibility}
              canChange={page.canShare}
              change={(next) => setPageVisibilityAction(page.slug, next)}
              privateMeans="Only whoever made it can see this page"
            />
          </span>
          {refresh && (
            <button
              className={button}
              disabled={pending || refresh.running}
              onClick={() => run(() => refreshPageAction(page.slug), "Refreshing the data. The page updates when it's done.")}
              title={refresh.schedule ? `Refreshes ${refresh.schedule}` : "Refresh the data now"}
            >
              <RotateCw size={15} strokeWidth={1.6} className={refresh.running ? "animate-spin" : ""} />
              <span className="hidden sm:inline">{refresh.running ? "Refreshing" : "Refresh"}</span>
            </button>
          )}
          <button
            className={button}
            onClick={() => startCosMessage(`About the "${page.title}" page: `, setCosOpen)}
            title="Ask the Chief of Staff to change it"
          >
            <MessageSquare size={15} strokeWidth={1.6} />
            <span className="hidden sm:inline">Change</span>
          </button>
          <label className="sr-only" htmlFor="page-version">
            Version
          </label>
          <select
            id="page-version"
            value={viewing ?? page.version}
            onChange={(e) => {
              const v = Number(e.target.value);
              router.push(v === page.version ? `/pages/${page.slug}` : `/pages/${page.slug}?v=${v}`);
            }}
            className="max-w-48 truncate rounded border border-line bg-raised px-2 py-1 font-mono text-xs text-muted"
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
                {v.version === page.version ? " (latest)" : ""}
                {v.note ? ` · ${v.note.slice(0, 40)}` : ""}
              </option>
            ))}
          </select>
          <button
            className={button}
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete the ${page.title} page and its versions? Its data stays on the drive${refresh ? ", and its refresh job is archived" : ""}.`)) return;
              startTransition(async () => {
                const result = await deletePageAction(page.slug);
                if (result.error) return toast(result.error);
                toast("Page deleted.");
                router.push("/pages");
              });
            }}
            aria-label="Delete page"
            title="Delete page"
          >
            <Trash2 size={15} strokeWidth={1.6} />
          </button>
          <CosToggle />
        </div>
      </div>

      {viewing && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-accent-soft px-4 py-2 text-sm sm:px-8">
          <span>
            You&apos;re looking at version {viewing} of {page.version}.
          </span>
          <button
            className="underline decoration-accent underline-offset-4"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await restorePageAction(page.slug, viewing);
                if (result.error) return toast(result.error);
                toast(`Version ${viewing} is the latest again.`);
                router.push(`/pages/${page.slug}`);
              })
            }
          >
            Make it the latest
          </button>
          <Link href={`/pages/${page.slug}`} className="text-muted hover:text-ink">
            Back to the latest
          </Link>
        </div>
      )}

      <iframe
        ref={frame}
        key={src}
        src={src}
        title={page.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0 bg-panel"
      />
    </>
  );
}

/** A short, stable number for a string, to bust the frame's URL when data changes. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h >>> 0;
}
