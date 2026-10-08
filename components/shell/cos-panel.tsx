"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type FileUIPart } from "ai";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { sendSignInCodeAction } from "@/app/(app)/integrations/actions";
import { pickOptionAction } from "@/app/(app)/tasks/actions";
import { CredentialsForm, StatusLine } from "@/components/credentials-form";
import { PendingAttachments, useReplyAttachments } from "@/components/reply-attachments";
import type { IntegrationStatus } from "@/lib/integrations";
import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import type { LoginOutput } from "@/lib/agents/toolkit";
import type { ChecklistItem } from "@/lib/profile/markdown";
import type { TaskStatus } from "@/lib/task-words";

import { COS_DRAFT_EVENT, cosDraft, cosFocus, useShell } from "./shell";

type ToolPart = Extract<ChiefOfStaffMessage["parts"][number], { type: `tool-${string}` }>;

// History is stored on the server, so only the newest message is sent, with
// the files attached to it (already uploaded to Blob; the server takes them
// into the company's file library).
const transport = new DefaultChatTransport<ChiefOfStaffMessage>({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages, body }) => ({
    body: { id, message: messages.at(-1), ...(body?.uploads ? { uploads: body.uploads } : {}) },
  }),
});

// Tools whose results change what other screens show (tasks, the profile, the team).
const REFRESHING_TOOLS = new Set([
  "create_task",
  "create_agent",
  "suggest_profile_update",
  "update_section",
  "set_company_name",
  "save_person",
  "remove_person",
  "complete_onboarding",
  "connect_data_source",
  "connect_login",
  "save_page",
  "refresh_page",
]);

export type IntegrationState = Record<string, { status: IntegrationStatus; detail: string; hasCredentials: boolean }>;

export function CosPanel({
  chatId,
  initialMessages: loadedMessages,
  checklist,
  suggestionStatus,
  integrationStatus,
  uploadPrefix,
  canAttach,
}: {
  chatId: string;
  initialMessages: ChiefOfStaffMessage[];
  checklist: ChecklistItem[];
  suggestionStatus: Record<string, TaskStatus>;
  integrationStatus: IntegrationState;
  /** Where this company's uploads go in Blob (see /api/uploads). */
  uploadPrefix: string;
  /** Whether files can be attached (a Blob store is connected). */
  canAttach: boolean;
}) {
  const { data, setCosOpen, toast } = useShell();
  const router = useRouter();
  // Page refreshes bring newer history from the server; the chat keeps its own copy from first load.
  const [initialMessages] = useState(loadedMessages);
  const { messages, sendMessage, status, error, stop } = useChat<ChiefOfStaffMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const onboarded = data.organization.onboarded;

  // When a tool changes tasks, the profile or the team, refresh the page behind the chat.
  const finishedTools = messages
    .slice(initialMessages.length)
    .flatMap((m) => m.parts)
    .filter((p) => isToolUIPart(p) && p.state === "output-available" && REFRESHING_TOOLS.has(getToolName(p))).length;
  useEffect(() => {
    if (finishedTools > 0) router.refresh();
  }, [finishedTools, router]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    // Jump to the newest message when the panel opens; glide after that.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: scrolled.current ? "smooth" : "instant" });
    scrolled.current = true;
  }, [messages]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Only when someone opened the panel; on page loads, keys stay with the page.
    if (cosFocus.requested) inputRef.current?.focus({ preventScroll: true });
    cosFocus.requested = false;
  }, []);

  useEffect(() => {
    // A page asked to start a message ("About the Net worth page: "): put it in the box, ready to finish.
    const take = () => {
      if (!cosDraft.text) return;
      const text = cosDraft.text;
      cosDraft.text = "";
      setInput(text);
      requestAnimationFrame(() => {
        const box = inputRef.current;
        box?.focus({ preventScroll: true });
        box?.setSelectionRange(text.length, text.length);
      });
    };
    take();
    window.addEventListener(COS_DRAFT_EVENT, take);
    return () => window.removeEventListener(COS_DRAFT_EVENT, take);
  }, []);

  const attachments = useReplyAttachments({ prefix: uploadPrefix, enabled: canAttach, onError: (message) => toast(message) });
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (input.trim() !== "" || attachments.uploads.length > 0) && !attachments.uploading;

  const send = (text: string) => {
    const uploads = attachments.uploads;
    if ((!text.trim() && uploads.length === 0) || busy || attachments.uploading) return;
    // Shown in the message straight away; the server keeps links to the saved files.
    const files: FileUIPart[] = attachments.pending
      .filter((p) => p.blobPathname)
      .map((p) => ({ type: "file", mediaType: p.contentType || "application/octet-stream", filename: p.name, url: p.preview ?? "" }));
    sendMessage(text.trim() ? { text, files } : { files }, uploads.length ? { body: { uploads } } : undefined);
    setInput("");
    attachments.clear({ keepPreviews: true });
  };

  const started = checklist.some((item) => item.done);

  return (
    <aside
      aria-label="Chief of Staff"
      className="frame flex h-full w-full flex-col bg-panel"
    >
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h2 className="label text-ink">Chief of Staff</h2>
          <span className="label text-faint">{onboarded ? "" : "· Onboarding"}</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/company" className="label text-faint hover:text-ink" title="The company profile the Chief of Staff keeps">
            What I know
          </Link>
          <button onClick={() => setCosOpen(false)} aria-label="Close" className="flex items-center gap-2 text-faint hover:text-ink">
            <kbd className="kbd">C</kbd>
            <X size={16} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {!onboarded && <Checklist items={checklist} />}

        {messages.length === 0 && (
          <div className="space-y-4 pt-4">
            <p className="text-[15px] leading-relaxed text-muted">
              {onboarded
                ? "Ask anything about the company, or tell me what needs doing and I'll turn it into a task for the right person or agent."
                : "A few minutes to get the basics: what you do, who's on the team and your top priorities. Everything else gets filled in over time."}
            </p>
            {!onboarded && (
              <button onClick={() => send(started ? "Hi, let's finish setting up." : "Hi, let's get set up.")} className="btn btn-primary">
                {started ? "Continue onboarding" : "Start onboarding"}
              </button>
            )}
          </div>
        )}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex flex-col items-end gap-1">
              <div className="max-w-[88%] border border-line bg-raised px-3.5 py-2 text-[15px]">
                {message.parts.map((part, i) => (part.type === "text" ? <p key={i} className="whitespace-pre-wrap">{part.text}</p> : null))}
                <ChatFiles files={message.parts.filter((p): p is FileUIPart => p.type === "file")} />
              </div>
              {channelOf(message) && <span className="label text-[10px] text-faint">via {channelOf(message) === "whatsapp" ? "WhatsApp" : "email"}</span>}
            </div>
          ) : (
            <div key={message.id} className="space-y-2.5">
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <div key={i} className="prose prose-mach prose-sm max-w-none text-[15px] leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                    </div>
                  );
                }
                if (isToolUIPart(part)) {
                  return (
                    <ToolPart
                      key={i}
                      part={part as ToolPart}
                      suggestionStatus={suggestionStatus}
                      integrationStatus={integrationStatus}
                      latest={message.id === messages.at(-1)?.id}
                      tell={(text) => !busy && sendMessage({ text })}
                    />
                  );
                }
                return null;
              })}
            </div>
          ),
        )}

        {status === "submitted" && <p className="label animate-pulse">Thinking…</p>}
        {error && <p className="border border-danger/40 px-3 py-2 text-sm text-danger">Something went wrong: {error.message}</p>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          attachments.add(Array.from(e.dataTransfer.files));
        }}
        className="border-t border-line p-3"
      >
        <div className="border border-line bg-raised focus-within:border-muted">
          {attachments.pending.length > 0 && (
            <div className="pt-2">
              <PendingAttachments pending={attachments.pending} onRemove={attachments.remove} />
            </div>
          )}
          <div className="flex items-end gap-2 px-3 py-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files);
                if (!pasted.length) return;
                e.preventDefault();
                attachments.add(pasted);
              }}
              rows={2}
              placeholder={onboarded ? "Ask, or say what needs doing…" : "Tell me about your company…"}
              className="min-w-0 flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
            />
            {canAttach && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    attachments.add(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach files or photos" title="Attach files or photos" className="btn btn-ghost px-2">
                  <Paperclip size={15} />
                </button>
              </>
            )}
            {busy ? (
              <button type="button" onClick={stop} aria-label="Stop" className="btn px-2">
                <Square size={14} />
              </button>
            ) : (
              <button type="submit" disabled={!canSend} aria-label="Send" className="btn btn-primary px-2">
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}

function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <div className="border border-line bg-raised p-4">
      <p className="label mb-3">The essentials</p>
      <ul className="space-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item.label} className="flex items-baseline gap-2">
            <span className={item.done ? "text-ok" : "text-faint"}>{item.done ? "✓" : "○"}</span>
            <span className={item.done ? "" : "text-muted"}>{item.label}</span>
            {item.detail && <span className="text-faint">· {item.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Files attached to a message: images as thumbnails, anything else by name. Each opens from the company's files. */
function ChatFiles({ files }: { files: FileUIPart[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {files.map((file, i) => {
        const name = file.filename ?? "File";
        const image = /^image\/(png|jpe?g|gif|webp)$/.test(file.mediaType) && file.url;
        const opens = file.url.startsWith("/files/");
        const body = image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a private file served by the app, or a local preview
          <img src={file.url} alt={name} className="h-20 max-w-[180px] object-cover" />
        ) : (
          <span className="flex items-center gap-1.5 px-2 py-1 text-xs">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="max-w-40 truncate">{name}</span>
          </span>
        );
        return opens ? (
          <a key={i} href={file.url} target="_blank" rel="noreferrer" title={name} className="block border border-line bg-panel hover:border-muted">
            {body}
          </a>
        ) : (
          <span key={i} title={name} className="block border border-line bg-panel">
            {body}
          </span>
        );
      })}
    </div>
  );
}

/** Where a message came from, when it wasn't this panel. */
const channelOf = (message: { metadata?: unknown }) => (message.metadata as { channel?: "whatsapp" | "email" } | undefined)?.channel;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function ToolPart({
  part,
  suggestionStatus,
  integrationStatus,
  latest,
  tell,
}: {
  part: ToolPart;
  suggestionStatus: Record<string, TaskStatus>;
  integrationStatus: IntegrationState;
  /** In the newest message: a code card there is still live; older ones are history. */
  latest: boolean;
  /** Tells the Chief of Staff something happened in a card (credentials saved, a code entered), so it carries on. */
  tell: (text: string) => void;
}) {
  const name = getToolName(part);
  const done = part.state === "output-available";

  if (part.type === "tool-create_task" && done && part.output.task) {
    const { task, members = [] } = part.output;
    return (
      <Link
        href={`/tasks/${task.number}`}
        className="block border border-line bg-raised px-3.5 py-3 hover:border-muted"
      >
        <p className="label mb-1">Task #{task.number} created</p>
        <p className="text-[15px]">{task.title}</p>
        <p className="mt-1 text-xs text-muted">{members.join(" · ")}</p>
      </Link>
    );
  }

  if (part.type === "tool-suggest_profile_update" && done && part.output.suggestion) {
    const { suggestion } = part.output;
    return <SuggestionCard suggestion={suggestion} status={suggestionStatus[suggestion.id]} />;
  }

  if (part.type === "tool-connect_data_source" && done && part.output.integration) {
    const { integration } = part.output;
    return <IntegrationCard integration={integration} live={integrationStatus[integration.id]} tell={tell} />;
  }
  if (part.type === "tool-connect_login" && done && part.output.integration) {
    const { integration } = part.output;
    return <IntegrationCard integration={integration} live={integrationStatus[integration.id]} tell={tell} login />;
  }
  if (part.type === "tool-save_page" && done && part.output.page) {
    const { page, created } = part.output;
    return (
      <Link href={`/pages/${page.slug}`} className="block border border-line bg-raised px-3.5 py-3 hover:border-muted">
        <p className="label mb-1">
          Page {created ? "created" : `saved · v${page.version}`}
          {page.pinned ? " · tab on Home" : ""}
        </p>
        <p className="text-[15px]">{page.title}</p>
        <p className="mt-1 text-xs text-muted">Open it</p>
      </Link>
    );
  }
  const needsCode = name === "browser_login" && done ? (part.output as unknown as LoginOutput).needsCode : undefined;
  if (needsCode && latest) return <SignInCodeCard login={needsCode} tell={tell} />;

  const input = (part.input ?? {}) as Record<string, string | undefined>;
  const labels: Record<string, string> = {
    connect_data_source: `Connecting ${input.name ?? "a data source"}`,
    connect_login: `Connecting ${input.name ?? "a login"}`,
    call_api: `Read ${input.integration ?? "a data source"}${input.path ? ` ${truncate(input.path, 40)}` : ""}`,
    set_company_name: `Company name: ${input.name ?? ""}`,
    update_section: `Updated ${input.section ?? "a section"}`,
    save_person: `Saved ${input.name ?? "a person"}${input.reportsTo ? ` → ${input.reportsTo}` : ""}`,
    remove_person: `Removed ${input.name ?? "a person"}`,
    complete_onboarding:
      part.type === "tool-complete_onboarding" && done
        ? part.output.onboardingComplete
          ? "Onboarding complete"
          : `Still missing: ${part.output.missing.join(", ")}`
        : "Checking onboarding",
    create_task: `Creating task: ${input.title ?? ""}`,
    create_agent: `Created agent: ${input.name ?? ""}`,
    suggest_profile_update: `Suggesting a change to ${input.section ?? "the profile"}`,
    use_skill: `Read the ${input.name ?? ""} playbook`,
    web_search: `Searched${input.objective ? `: ${truncate(input.objective, 50)}` : " the web"}`,
    fetch_page: `Read ${input.url ? truncate(input.url.replace(/^https?:\/\//, ""), 50) : "a page"}`,
    browse: `Opened ${input.url ? truncate(input.url.replace(/^https?:\/\//, ""), 50) : "a page"} in the browser`,
    browser_login: needsCode ? `${input.login ?? "The site"} asked for a sign-in code` : `Signed in to ${input.login ?? "a site"}`,
    run_code: `Ran ${input.filename ?? "a script"}`,
    run_command: `Ran ${truncate(input.command ?? "a command", 40)}`,
    read_file: `Read ${input.path ?? "a file"}`,
    write_file: `Wrote ${input.path ?? "a file"}`,
    list_files: "Listed files",
    read_integration_guide: `Read the ${input.integration ?? ""} guide`,
    save_integration_guide: `Updated the ${input.integration ?? ""} guide`,
    save_page: `Saving the ${input.title ?? ""} page`,
    read_page: `Read the ${input.page ?? ""} page`,
    refresh_page: `Scheduled the ${input.page ?? ""} page's refresh`,
  };
  const failed =
    part.state === "output-error" ||
    (done && typeof part.output === "object" && part.output !== null && Boolean((part.output as { error?: string }).error));
  return (
    <p className={`flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider ${failed ? "text-danger" : "text-faint"}`}>
      <span>{failed ? "✕" : done ? "✓" : "…"}</span>
      <span className="truncate">{labels[name] ?? name}</span>
    </p>
  );
}

function IntegrationCard({
  integration,
  live,
  tell,
  login = false,
}: {
  integration: { id: string; slug: string; name: string; baseUrl: string; fields: { name: string; label: string; secret?: boolean; optional?: boolean }[] };
  live?: { status: IntegrationStatus; detail: string; hasCredentials: boolean };
  tell: (text: string) => void;
  login?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // Deleted since: the card stays in the chat's history, but there's nothing to connect.
  if (!live) {
    return (
      <div className="border border-line bg-raised px-3.5 py-3">
        <p className="label mb-1">{login ? "Login" : "Data source"} · {integration.name}</p>
        <p className="text-xs text-faint">Removed.</p>
      </div>
    );
  }
  const connected = live.hasCredentials && live.status !== "needs_credentials";
  return (
    <div className="border border-line bg-raised">
      <div className="border-b border-line-soft px-3.5 py-3">
        <p className="label mb-1 flex items-center gap-2">
          <span className="h-1.5 w-1.5 bg-accent" /> {login ? "Login" : "Data source"} · {integration.slug}
        </p>
        <p className="text-[15px]">{integration.name}</p>
        <p className="mt-0.5 truncate font-mono text-xs text-faint">{integration.baseUrl}</p>
        <div className="mt-1.5">
          <StatusLine status={live.status} detail={live.detail} />
        </div>
      </div>
      <div className="px-3.5 py-3">
        {connected && !editing ? (
          <div className="flex items-center gap-4 text-xs">
            <button onClick={() => setEditing(true)} className="text-muted hover:text-ink">
              Update credentials
            </button>
            <Link href="/settings/integrations" className="text-muted hover:text-ink">
              Manage in Integrations
            </Link>
          </div>
        ) : (
          <CredentialsForm
            id={integration.id}
            fields={integration.fields}
            hasCredentials={live.hasCredentials}
            onDone={(result) => {
              setEditing(false);
              tell(
                `I've entered the ${login ? "sign-in details" : "credentials"} for ${integration.name}${
                  result.status === "failing" ? ` (the test says: ${result.detail ?? "it failed"})` : ""
                }.`,
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  status,
}: {
  suggestion: { id: string; number: number; section: string; content: string; reason: string };
  status: TaskStatus | undefined;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const settled = status === "done" ? "Applied" : status === "cancelled" ? "Dismissed" : null;
  const act = (index: number) =>
    start(async () => {
      const result = await pickOptionAction(suggestion.id, index);
      if (result.error) setError(result.error);
    });

  return (
    <div className="border border-line bg-raised">
      <div className="px-3.5 pt-3">
        <p className="label mb-1 flex items-center gap-2">
          <span className="h-1.5 w-1.5 bg-accent" /> Suggested update · {suggestion.section}
        </p>
        <p className="text-[15px]">{suggestion.reason}</p>
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-muted hover:text-ink">
          {open ? "Hide the new text" : "Show the new text"}
        </button>
        {open && (
          <div className="prose prose-mach prose-sm mt-2 max-w-none border-l-2 border-line pl-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{suggestion.content}</ReactMarkdown>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-line-soft px-3.5 py-2">
        {settled ? (
          <span className="label">{settled}</span>
        ) : (
          <>
            <button disabled={pending} onClick={() => act(0)} className="btn btn-primary">
              Apply
            </button>
            <button disabled={pending} onClick={() => act(1)} className="btn btn-ghost">
              Dismiss
            </button>
          </>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

/** A site sent the Chief of Staff's browser a sign-in code: it goes from here straight to the browser, not into the chat. */
function SignInCodeCard({ login, tell }: { login: { slug: string; name: string }; tell: (text: string) => void }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const result = await sendSignInCodeAction(login.slug, code);
      if (result.error) return setError(result.error);
      setSent(true);
      setCode("");
      tell(`I've entered the ${login.name} sign-in code.`);
    });
  return (
    <div className="border border-line bg-raised px-3.5 py-3">
      <p className="label mb-1 flex items-center gap-2">
        <span className="h-1.5 w-1.5 bg-accent" /> Sign-in code · {login.slug}
      </p>
      {sent ? (
        <p className="text-sm text-muted">Sent to the browser.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-2"
          autoComplete="off"
        >
          <p className="text-sm text-muted">{login.name} sent a code (by text, email or your authenticator app). It goes straight to the sign-in, not into this chat.</p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              aria-label="Sign-in code"
              className="field min-w-0 flex-1 font-mono"
            />
            <button type="submit" disabled={pending || !code.trim()} className="btn btn-primary">
              Send
            </button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
    </div>
  );
}
