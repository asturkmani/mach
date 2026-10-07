"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { ArrowUp, Square, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { pickOptionAction } from "@/app/(app)/tasks/actions";
import { CredentialsForm, StatusLine } from "@/components/credentials-form";
import type { IntegrationStatus } from "@/lib/integrations";
import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import type { ChecklistItem } from "@/lib/profile/markdown";
import type { TaskStatus } from "@/lib/task-words";

import { cosFocus, useShell } from "./shell";

type ToolPart = Extract<ChiefOfStaffMessage["parts"][number], { type: `tool-${string}` }>;

// History is stored on the server, so only the newest message is sent.
const transport = new DefaultChatTransport<ChiefOfStaffMessage>({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
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
]);

export type IntegrationState = Record<string, { status: IntegrationStatus; detail: string; hasCredentials: boolean }>;

export function CosPanel({
  chatId,
  initialMessages: loadedMessages,
  checklist,
  suggestionStatus,
  integrationStatus,
}: {
  chatId: string;
  initialMessages: ChiefOfStaffMessage[];
  checklist: ChecklistItem[];
  suggestionStatus: Record<string, TaskStatus>;
  integrationStatus: IntegrationState;
}) {
  const { data, setCosOpen } = useShell();
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

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
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
        <button onClick={() => setCosOpen(false)} aria-label="Close" className="flex items-center gap-2 text-faint hover:text-ink">
          <kbd className="kbd">C</kbd>
          <X size={16} />
        </button>
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
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[88%] border border-line bg-raised px-3.5 py-2 text-[15px]">
                {message.parts.map((part, i) => (part.type === "text" ? <p key={i} className="whitespace-pre-wrap">{part.text}</p> : null))}
              </div>
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
                    <ToolPart key={i} part={part as ToolPart} suggestionStatus={suggestionStatus} integrationStatus={integrationStatus} />
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
        className="border-t border-line p-3"
      >
        <div className="flex items-end gap-2 border border-line bg-raised px-3 py-2 focus-within:border-muted">
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
            rows={2}
            placeholder={onboarded ? "Ask, or say what needs doing…" : "Tell me about your company…"}
            className="min-w-0 flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          {busy ? (
            <button type="button" onClick={stop} aria-label="Stop" className="btn px-2">
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} aria-label="Send" className="btn btn-primary px-2">
              <ArrowUp size={15} />
            </button>
          )}
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

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function ToolPart({
  part,
  suggestionStatus,
  integrationStatus,
}: {
  part: ToolPart;
  suggestionStatus: Record<string, TaskStatus>;
  integrationStatus: IntegrationState;
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
    return <IntegrationCard integration={integration} live={integrationStatus[integration.id]} />;
  }
  if (part.type === "tool-connect_login" && done && part.output.integration) {
    const { integration } = part.output;
    return <IntegrationCard integration={integration} live={integrationStatus[integration.id]} login />;
  }

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
  login = false,
}: {
  integration: { id: string; slug: string; name: string; baseUrl: string; fields: { name: string; label: string; secret?: boolean; optional?: boolean }[] };
  live?: { status: IntegrationStatus; detail: string; hasCredentials: boolean };
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
            <Link href="/integrations" className="text-muted hover:text-ink">
              Manage in Integrations
            </Link>
          </div>
        ) : (
          <CredentialsForm id={integration.id} fields={integration.fields} hasCredentials={live.hasCredentials} onDone={() => setEditing(false)} />
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
