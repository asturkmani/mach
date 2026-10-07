"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChiefOfStaffMessage } from "@/lib/agents/chief-of-staff";
import { onboardingChecklist } from "@/lib/profile/markdown";

type ToolPart = Extract<ChiefOfStaffMessage["parts"][number], { type: `tool-${string}` }>;

// History is stored on the server, so only the newest message is sent.
const transport = new DefaultChatTransport<ChiefOfStaffMessage>({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
});

export function Onboarding({
  chatId,
  initialMessages,
  initialProfile,
  initiallyComplete,
}: {
  chatId: string;
  initialMessages: ChiefOfStaffMessage[];
  initialProfile: string;
  initiallyComplete: boolean;
}) {
  const { messages, sendMessage, status, error, stop } = useChat<ChiefOfStaffMessage>({
    id: chatId,
    messages: initialMessages,
    transport,
  });
  const [input, setInput] = useState("");
  const [view, setView] = useState<"preview" | "markdown">("preview");
  const busy = status === "submitted" || status === "streaming";

  // The profile shown is the newest one returned by a tool call in this visit;
  // older stored tool results may predate changes made elsewhere (e.g. Team page).
  const profile = useMemo(() => {
    for (let m = messages.length - 1; m >= initialMessages.length; m--) {
      const parts = messages[m].parts;
      for (let p = parts.length - 1; p >= 0; p--) {
        const part = parts[p];
        if (isToolUIPart(part) && part.state === "output-available") {
          const output = part.output as { profile?: string } | undefined;
          if (output?.profile) return output.profile;
        }
      }
    }
    return initialProfile;
  }, [messages, initialMessages.length, initialProfile]);

  const complete =
    initiallyComplete ||
    messages.some((m) =>
      m.parts.some((part) => part.type === "tool-complete_onboarding" && part.state === "output-available"),
    );
  const checklist = onboardingChecklist(profile);
  const started = onboardingChecklist(initialProfile).some((item) => item.done);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text });
    setInput("");
  };

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        {/* Chat with the Chief of Staff */}
        <section className="flex min-h-0 flex-col border-zinc-200 lg:border-r dark:border-zinc-800">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-6">
            {messages.length === 0 && (
              <div className="mx-auto max-w-md space-y-4 pt-10 text-center">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {complete ? "Your Chief of Staff" : "Meet your Chief of Staff"}
                </h1>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {complete
                    ? "Ask questions or tell it anything new about the company; it keeps the profile up to date."
                    : "A few minutes to get the basics: what you do, who's on the team and your top priorities. Everything else gets filled in over time."}
                </p>
                <button
                  onClick={() =>
                    send(
                      complete
                        ? "Hi."
                        : started
                          ? "Hi, let's finish setting up."
                          : "Hi, let's get set up.",
                    )
                  }
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  {complete ? "Start a conversation" : started ? "Continue onboarding" : "Start onboarding"}
                </button>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    message.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "max-w-[85%] space-y-2"
                  }
                >
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return message.role === "user" ? (
                        <p key={i} className="whitespace-pre-wrap">
                          {part.text}
                        </p>
                      ) : (
                        <div key={i} className="prose prose-zinc prose-sm max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                        </div>
                      );
                    }
                    if (isToolUIPart(part)) return <ToolChip key={i} part={part as ToolPart} />;
                    return null;
                  })}
                </div>
              </div>
            ))}

            {status === "submitted" && <p className="text-sm text-zinc-500">Thinking…</p>}
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                Something went wrong: {error.message}
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={2}
              placeholder="Tell your Chief of Staff about your company…"
              className="min-w-0 flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            {busy ? (
              <button
                type="button"
                onClick={stop}
                className="rounded-lg border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Send
              </button>
            )}
          </form>
        </section>

        {/* Live company profile */}
        <section className="flex min-h-0 flex-col border-t border-zinc-200 lg:border-t-0 dark:border-zinc-800">
          <div className="flex items-center justify-between px-4 py-2">
            <h2 className="text-sm font-medium text-zinc-500">company-profile.md</h2>
            <div className="flex items-center gap-1 text-sm">
              {(["preview", "markdown"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-md px-2 py-1 capitalize ${
                    view === v ? "bg-zinc-200 dark:bg-zinc-800" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  }`}
                >
                  {v}
                </button>
              ))}
              <a
                href={`data:text/markdown;charset=utf-8,${encodeURIComponent(profile)}`}
                download="company-profile.md"
                className="rounded-md px-2 py-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Download
              </a>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
            <Checklist items={checklist} complete={complete} />
            {view === "preview" ? (
              <article className="prose prose-zinc max-w-none dark:prose-invert prose-table:text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{profile}</ReactMarkdown>
              </article>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{profile}</pre>
            )}
          </div>
        </section>
    </main>
  );
}

function Checklist({ items, complete }: { items: ReturnType<typeof onboardingChecklist>; complete: boolean }) {
  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-2 font-medium">
        {complete ? "Onboarding complete" : "Onboarding: the essentials"}
      </p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.label} className="flex items-baseline gap-2">
            <span className={item.done ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
              {item.done ? "✓" : "○"}
            </span>
            <span className={item.done ? "" : "text-zinc-500"}>{item.label}</span>
            {item.detail && <span className="text-zinc-500">· {item.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolChip({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, string | undefined>;
  const labels: Record<string, string> = {
    set_company_name: `Company name: ${input.name ?? ""}`,
    update_section: `Updated section: ${input.section ?? ""}`,
    save_person: `Saved person: ${input.name ?? ""}${input.reportsTo ? ` (reports to ${input.reportsTo})` : ""}`,
    remove_person: `Removed person: ${input.name ?? ""}`,
    complete_onboarding: "Onboarding complete",
    web_search: `Searched the web${input.objective ? `: ${truncate(input.objective, 60)}` : ""}`,
    fetch_page: `Read ${input.url ?? "a page"}`,
  };
  const label = labels[name] ?? name;
  const failed = part.state === "output-error";
  const done = part.state === "output-available";
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
        failed
          ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
          : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
      }`}
    >
      <span>{failed ? "✕" : done ? "✓" : "…"}</span>
      <span>{label}</span>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
