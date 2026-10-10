import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACTIONS, getAction } from "@/lib/actions";

// Keeps chat in step with the screens: every server action a screen calls
// (app/**/actions.ts) must go through the action registry (performAs, or an
// operation in lib/operations.ts that a registered action also uses), or be
// one of the Chief of Staff's own tools, or be listed below as screen-only
// with the reason. A new screen action that's none of these fails here.

/** Server actions the Chief of Staff does with one of its own tools. */
const CHAT_TOOL: Record<string, string> = {
  createTaskAction: "create_task",
  replyAction: "reply_on_task",
  searchTasksAction: "find_tasks",
  createAgentAction: "create_agent",
};

/** Server actions that never go through chat, and why. */
const SCREEN_ONLY: Record<string, string> = {
  signOutAction: "signs this browser out",
  rememberTimezoneAction: "the browser reports its own timezone",
  stopChatAction: "the stop button on a reply in progress",
  subscribePushAction: "this device's notifications",
  unsubscribePushAction: "this device's notifications",
  deleteCompanyAction: "deleting the company is never done through chat",
  startWhatsAppLinkAction: "linking WhatsApp needs proof from the phone itself",
  unlinkWhatsAppAction: "linking WhatsApp is never done through chat",
  registerDriveUploadAction: "a file someone uploads on the screen (in chat they send it, and it's saved)",
  deleteDriveFileAction: "the drive is the Chief of Staff's own working files: it changes them in its sandbox",
  saveCredentialsAction: "credentials never pass through chat",
  sendSignInCodeAction: "a sign-in code goes from its card straight to the browser, never through the model",
  saveAiKeyAction: "credentials never pass through chat",
  removeAiKeyAction: "AI keys are only managed on the screen",
  sendQueuedNowAction: "sends a message the person queued on the screen",
  approveOrDoneAction: "the E shortcut: task.pick_option or task.set_status done",
  restoreAction: "the Z shortcut: undo on the screen",
  emailStep: "signing in",
  codeStep: "signing in",
  verifyStep: "signing in",
  companyStep: "signing in",
  resendCode: "signing in",
  createCompany: "creating a company, before there's a chat",
  openCompany: "choosing a company, before there's a chat",
  acceptInvitationAction: "joining a company, before there's a chat",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name === "actions.ts" ? [join(dir, entry.name)] : [],
  );
}

/** Top-level functions in a file and their bodies (up to the next top-level declaration). */
function functionsIn(source: string): { name: string; exported: boolean; body: string }[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?function (\w+)/gm)];
  return starts.map((match) => {
    const end = source.slice(match.index + 1).search(/^(?:export |async |function |const |type |\/\*\*)/m);
    return { name: match[2], exported: Boolean(match[1]), body: source.slice(match.index, end < 0 ? undefined : match.index + 1 + end) };
  });
}

const registry = ["tasks.ts", "company.ts", "research.ts"].map((f) => readFileSync(join(process.cwd(), "lib/actions", f), "utf8")).join("\n");
const sharedOperations = new Set([...registry.matchAll(/\b(\w+As)\(/g)].map((m) => m[1]));
const chiefOfStaff = readFileSync(join(process.cwd(), "lib/agents/chief-of-staff.ts"), "utf8");

const serverActions = files(join(process.cwd(), "app")).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  const all = functionsIn(source);
  // A function goes through the registry if it calls performAs, a shared
  // operation, or a helper in its file that does.
  const through = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of all) {
      if (through.has(fn.name)) continue;
      const calls = [...fn.body.matchAll(/\b(\w+)\(/g)].map((m) => m[1]).filter((c) => c !== fn.name);
      if (calls.some((c) => c === "performAs" || sharedOperations.has(c) || through.has(c))) {
        through.add(fn.name);
        changed = true;
      }
    }
  }
  return all.filter((fn) => fn.exported).map((fn) => ({ file, name: fn.name, through: through.has(fn.name), source }));
});

describe("every screen action is open to the Chief of Staff", () => {
  it("finds the server actions", () => {
    expect(serverActions.length).toBeGreaterThan(40);
  });

  it("goes through the registry, a Chief of Staff tool, or is screen-only for a reason", () => {
    const missing = serverActions.filter((a) => !a.through && !CHAT_TOOL[a.name] && !SCREEN_ONLY[a.name]).map((a) => `${a.name} (${a.file})`);
    expect(missing, "Declare these in lib/actions and call performAs, or list them in this test").toEqual([]);
  });

  it("names only actions and tools that exist", () => {
    const named = serverActions.flatMap((a) => [...a.source.matchAll(/"((?:task|person|agent|file|page|integration|company|me|source)\.[a-z_]+)"/g)].map((m) => m[1]));
    expect(named.filter((name) => !getAction(name))).toEqual([]);
    for (const tool of Object.values(CHAT_TOOL)) expect(chiefOfStaff, tool).toContain(`    ${tool}: tool({`);
    const exported = new Set(serverActions.map((a) => a.name));
    expect([...Object.keys(CHAT_TOOL), ...Object.keys(SCREEN_ONLY)].filter((name) => !exported.has(name)), "stale entries").toEqual([]);
    expect(serverActions.filter((a) => a.through && (CHAT_TOOL[a.name] || SCREEN_ONLY[a.name])).map((a) => a.name), "goes through the registry now").toEqual([]);
  });

  it("describes every action for the catalogue, with unique names", () => {
    expect(new Set(ACTIONS.map((a) => a.name)).size).toBe(ACTIONS.length);
    for (const action of ACTIONS) {
      expect(action.name).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(action.description.length, action.name).toBeGreaterThan(10);
    }
  });
});
