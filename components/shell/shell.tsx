"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { InboxItem } from "@/lib/inbox-arrivals";

import { HelpDialog, LaterDialog, NewTaskDialog } from "./dialogs";
import { Palette, type Command } from "./palette";

// The shell owns everything keyboard-driven: shortcuts, the ⌘K palette,
// undo, toasts and the dialogs any page can open. Pages add their own keys
// (J/K on a list, 1/2/3 on a task) with useKeys, and their own palette
// commands with useCommands.

export type ShellData = {
  me: { personId: string; name: string; email: string; isAdmin: boolean };
  organization: { name: string; onboarded: boolean; timezone: string | null };
  people: { id: string; name: string; role: string }[];
  agents: { id: string; name: string; role: string }[];
  inboxCount: number;
  /** What's in this person's inbox now, so the shell can notify them when something arrives. */
  inbox: InboxItem[];
  inProgressCount: number;
  /** Agents working right now, for the status in the left menu. */
  working: { number: number; title: string; agent: string; activity: string; since: string | null }[];
  /** The company's pages; pinned ones are tabs on Home. */
  pages: { slug: string; title: string; pinned: boolean }[];
};


type KeyHandler = (event: KeyboardEvent) => void;
type KeyMap = Record<string, KeyHandler>;
type Toast = { id: number; text: string; undo?: boolean; href?: string };
type Undo = { label: string; run: () => Promise<void> };
export type Theme = "system" | "light" | "dark";

type Shell = {
  data: ShellData;
  cosOpen: boolean;
  setCosOpen: (open: boolean) => void;
  openPalette: (mode?: "commands" | "search") => void;
  openNewTask: () => void;
  openLater: (taskId: string) => void;
  toast: (text: string, options?: { href?: string }) => void;
  /** Shows a toast and lets Z put things back. */
  pushUndo: (label: string, run: () => Promise<void>) => void;
  registerKeys: (keys: KeyMap) => () => void;
  registerCommands: (commands: Command[]) => () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside <ShellProvider>.");
  return shell;
}

/** Page-level shortcuts; the most recently mounted page wins for a key. */
export function useKeys(keys: KeyMap): void {
  const { registerKeys } = useShell();
  const ref = useRef(keys);
  useEffect(() => {
    ref.current = keys;
  });
  // Re-register only when the set of keys changes; handlers are read fresh from the ref.
  const signature = Object.keys(keys).sort().join(",");
  useEffect(() => {
    const proxy: KeyMap = {};
    for (const key of signature.split(",").filter(Boolean)) proxy[key] = (event) => ref.current[key]?.(event);
    return registerKeys(proxy);
  }, [registerKeys, signature]);
}

/** Commands this page adds to the ⌘K palette. */
export function useCommands(commands: Command[]): void {
  const { registerCommands } = useShell();
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  });
  // Commands are re-registered only when their ids or labels change.
  const signature = commands.map((c) => `${c.id}\u0000${c.label}`).join("\u0001");
  useEffect(() => {
    const proxies = ref.current.map((c) => ({ ...c, run: () => ref.current.find((x) => x.id === c.id)?.run() }));
    return registerCommands(proxies);
  }, [registerCommands, signature]);
}

/** Turns a keyboard event into a key name: "j", "enter", "mod+k", "shift+?" is just "?". */
export function keyName(event: KeyboardEvent): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  return mod ? `mod+${key}` : key === "arrowdown" ? "down" : key === "arrowup" ? "up" : key;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

const COS_KEY = "mach-cos-open";
const THEME_KEY = "mach-theme";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the setting just won't stick.
  }
}

/** Set when someone opens the Chief of Staff, so the panel takes focus then and not on every page load. */
export const cosFocus = { requested: false };

/** Text to put in the Chief of Staff's message box, e.g. "About the Net worth page: ". */
export const cosDraft = { text: "" };
export const COS_DRAFT_EVENT = "mach:cos-draft";

/** Opens the Chief of Staff with a message started for the person to finish. */
export function startCosMessage(text: string, setCosOpen: (open: boolean) => void): void {
  cosDraft.text = text;
  setCosOpen(true);
  window.dispatchEvent(new Event(COS_DRAFT_EVENT));
}

// The Chief of Staff panel's open state is a per-viewer preference kept in
// localStorage; components read it through this tiny store.
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const notify = () => listeners.forEach((l) => l());

/** Phones: below Tailwind's md breakpoint. */
const PHONE_QUERY = "(max-width: 767px)";
/** Below lg, the Chief of Staff covers the page instead of sitting beside it. */
const OVERLAY_QUERY = "(max-width: 1023px)";

/** Whether a media query matches. False on the server and until hydrated, so layouts lean on CSS breakpoints too. */
function useMedia(media: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(media);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(media).matches,
    () => false,
  );
}

/** True on a phone-sized screen. */
export const useIsPhone = () => useMedia(PHONE_QUERY);

export function ShellProvider({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const router = useRouter();
  const overlay = useMedia(OVERLAY_QUERY);
  const storedCos = useSyncExternalStore(
    subscribe,
    () => readStorage(COS_KEY),
    () => null,
  );
  // On a wide screen the panel sits beside the page and its open state is a saved preference,
  // open by default until onboarding is done, so the first thing people see is the conversation.
  // Narrower, it covers the page (a full-screen sheet on a phone), so it starts closed (open for
  // onboarding) and isn't saved.
  const panelOpen = storedCos === null ? !data.organization.onboarded : storedCos === "1";
  const [sheetOpen, setSheetOpen] = useState<boolean | null>(null);
  const cosOpen = overlay ? (sheetOpen ?? !data.organization.onboarded) : panelOpen;
  const setCosOpen = useCallback((open: boolean) => {
    cosFocus.requested = open;
    if (window.matchMedia(OVERLAY_QUERY).matches) return setSheetOpen(open);
    writeStorage(COS_KEY, open ? "1" : "0");
    notify();
  }, []);
  // Keep that default once shown, so finishing onboarding mid-conversation doesn't close the panel.
  useEffect(() => {
    if (!overlay && readStorage(COS_KEY) === null) writeStorage(COS_KEY, panelOpen ? "1" : "0");
  }, [overlay, panelOpen]);

  const storedTheme = useSyncExternalStore(
    subscribe,
    () => readStorage(THEME_KEY),
    () => null,
  );
  const theme: Theme = storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system";
  const setTheme = useCallback((next: Theme) => {
    writeStorage(THEME_KEY, next === "system" ? null : next);
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    notify();
  }, []);

  const [palette, setPalette] = useState<null | "commands" | "search">(null);
  const [newTask, setNewTask] = useState(false);
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const undoStack = useRef<Undo[]>([]);
  const keyStack = useRef<KeyMap[]>([]);
  const [pageCommands, setPageCommands] = useState<Command[][]>([]);

  const toast = useCallback((text: string, undo = false, href?: string) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { id, text, undo, href }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), undo ? 6000 : href ? 9000 : 3500);
  }, []);

  const pushUndo = useCallback(
    (label: string, run: () => Promise<void>) => {
      undoStack.current = [...undoStack.current.slice(-19), { label, run }];
      toast(label, true);
    },
    [toast],
  );

  const undo = useCallback(async () => {
    const last = undoStack.current.pop();
    if (!last) return toast("Nothing to undo.");
    await last.run();
    toast(`Undone: ${last.label.toLowerCase()}`);
  }, [toast]);

  const registerKeys = useCallback((keys: KeyMap) => {
    keyStack.current = [...keyStack.current, keys];
    return () => {
      keyStack.current = keyStack.current.filter((k) => k !== keys);
    };
  }, []);

  const registerCommands = useCallback((commands: Command[]) => {
    setPageCommands((all) => [...all, commands]);
    return () => setPageCommands((all) => all.filter((c) => c !== commands));
  }, []);

  const overlayOpen = palette !== null || newTask || laterFor !== null || help;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const name = keyName(event);
      if (name === "mod+k") {
        event.preventDefault();
        setPalette((open) => (open ? null : "commands"));
        return;
      }
      if (overlayOpen) {
        if (name === "escape") {
          setPalette(null);
          setNewTask(false);
          setLaterFor(null);
          setHelp(false);
        }
        return;
      }
      if (event.defaultPrevented) return;
      if (isTyping(event.target)) {
        if (name === "escape") (event.target as HTMLElement).blur();
        return;
      }
      if (event.altKey || (name.startsWith("mod+") && name !== "mod+enter")) return;

      for (let i = keyStack.current.length - 1; i >= 0; i--) {
        const handler = keyStack.current[i][name];
        if (handler) {
          event.preventDefault();
          handler(event);
          return;
        }
      }
      const global: Record<string, () => void> = {
        "/": () => setPalette("search"),
        n: () => setNewTask(true),
        c: () => setCosOpen(!cosOpen),
        "?": () => setHelp(true),
        z: () => void undo(),
      };
      if (global[name]) {
        event.preventDefault();
        global[name]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen, cosOpen, setCosOpen, undo]);

  const globalCommands = useMemo<Command[]>(
    () => [
      { id: "go-home", group: "Go to", label: "Home", run: () => router.push("/") },
      { id: "go-board", group: "Go to", label: "Home as a board", run: () => router.push("/?view=board") },
      { id: "go-list", group: "Go to", label: "Home as a list", run: () => router.push("/?view=list") },
      { id: "go-team", group: "Go to", label: "Team", run: () => router.push("/team") },
      { id: "go-agents", group: "Go to", label: "Agents", run: () => router.push("/team?show=agents") },
      { id: "go-files", group: "Go to", label: "Files", run: () => router.push("/files") },
      { id: "go-company", group: "Go to", label: "Company profile", run: () => router.push("/company") },
      { id: "go-settings", group: "Go to", label: "Settings", run: () => router.push("/settings") },
      { id: "go-integrations", group: "Go to", label: "Integrations", run: () => router.push("/settings/integrations") },
      { id: "go-account", group: "Go to", label: "Account settings", run: () => router.push("/settings/account") },
      { id: "new-task", group: "Create", label: "New task", keys: ["N"], run: () => setNewTask(true) },
      { id: "new-agent", group: "Create", label: "New agent", run: () => router.push("/team?new=agent") },
      { id: "new-person", group: "Create", label: "Add a person", run: () => router.push("/team?new=person") },
      {
        id: "cos",
        group: "Chief of Staff",
        label: cosOpen ? "Hide Chief of Staff" : "Talk to the Chief of Staff",
        keys: ["C"],
        run: () => setCosOpen(!cosOpen),
      },
      { id: "undo", group: "Edit", label: "Undo", keys: ["Z"], run: () => void undo() },
      { id: "theme-system", group: "Theme", label: `Theme: match system${theme === "system" ? " (current)" : ""}`, run: () => setTheme("system") },
      { id: "theme-light", group: "Theme", label: `Theme: light${theme === "light" ? " (current)" : ""}`, run: () => setTheme("light") },
      { id: "theme-dark", group: "Theme", label: `Theme: dark${theme === "dark" ? " (current)" : ""}`, run: () => setTheme("dark") },
      { id: "help", group: "Help", label: "Keyboard shortcuts", keys: ["?"], run: () => setHelp(true) },
    ],
    [router, cosOpen, setCosOpen, undo, theme, setTheme],
  );

  const shell = useMemo<Shell>(
    () => ({
      data,
      cosOpen,
      setCosOpen,
      openPalette: (mode = "commands") => setPalette(mode),
      openNewTask: () => setNewTask(true),
      openLater: (taskId) => setLaterFor(taskId),
      toast: (text, options) => toast(text, false, options?.href),
      pushUndo,
      registerKeys,
      registerCommands,
      theme,
      setTheme,
    }),
    [data, cosOpen, setCosOpen, toast, pushUndo, registerKeys, registerCommands, theme, setTheme],
  );

  return (
    <ShellContext.Provider value={shell}>
      {children}
      {palette && (
        <Palette
          mode={palette}
          commands={[...pageCommands.flat(), ...globalCommands]}
          onClose={() => setPalette(null)}
        />
      )}
      {newTask && <NewTaskDialog onClose={() => setNewTask(false)} />}
      {laterFor && <LaterDialog taskId={laterFor} onClose={() => setLaterFor(null)} />}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="enter-rise pointer-events-auto flex items-center gap-3 border border-line bg-raised px-4 py-2 text-sm shadow-[var(--shadow)]"
          >
            <span>{t.text}</span>
            {t.href && (
              <button
                onClick={() => {
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                  router.push(t.href!);
                }}
                className="text-accent-ink hover:underline"
              >
                Open
              </button>
            )}
            {t.undo && (
              <button onClick={() => void undo()} className="flex items-center gap-1.5 text-muted hover:text-ink">
                <kbd className="kbd">Z</kbd> Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </ShellContext.Provider>
  );
}
