// Which models Mach1 runs, by role, unless a company or an agent picked its
// own. Claude when the company brought an Anthropic key (it pays Anthropic
// directly); otherwise OpenAI, on Mach1's account. A role id ("mach1/chat")
// stands in for a model until a call is made (CompanyModel), so adding or
// removing a key changes the models straight away.

export const ROLES = ["chat", "worker", "coder", "browser", "planner", "background", "learner"] as const;
export type Role = (typeof ROLES)[number];
export type Lineup = "anthropic" | "openai";

const HAIKU = "anthropic/claude-haiku-5.5";
const SONNET = "anthropic/claude-sonnet-5.5";
const OPUS = "anthropic/claude-opus-5.5";
const LUNA = "openai/gpt-6-luna";
const LUNA_FAST = "openai/gpt-6-luna-fast";
const SOL = "openai/gpt-6.1-sol";
const ASTRA = "openai/gpt-6-astra";

/**
 * chat: the Chief of Staff, fast above all (it hands heavy work on).
 * worker, coder, browser: agents doing the work. planner: thinking a big
 * job through first. background: summaries and suggestions nobody waits on.
 * learner: reviewing work to propose changes to skills; learned skills
 * compound, so it runs on the planner model.
 */
export const LINEUPS: Record<Lineup, Record<Role, string>> = {
  anthropic: { chat: HAIKU, worker: SONNET, coder: SONNET, browser: SONNET, planner: OPUS, background: HAIKU, learner: OPUS },
  openai: { chat: LUNA_FAST, worker: SOL, coder: SOL, browser: ASTRA, planner: ASTRA, background: LUNA, learner: ASTRA },
};

const PREFIX = "mach1/";

/** The id that stands for a role's model, resolved per company when it's called. */
export const roleModel = (role: Role): string => `${PREFIX}${role}`;

export function roleOf(modelId: string): Role | null {
  const role = modelId.startsWith(PREFIX) ? modelId.slice(PREFIX.length) : "";
  return (ROLES as readonly string[]).includes(role) ? (role as Role) : null;
}

/** Claude when the company has an Anthropic key, else OpenAI. */
export function lineupFor(providersWithKeys: Iterable<string>): Lineup {
  return [...providersWithKeys].includes("anthropic") ? "anthropic" : "openai";
}

/** The model a call runs on: a role's model in the company's lineup, or the model id itself. */
export function resolveModel(modelId: string, lineup: Lineup): string {
  const role = roleOf(modelId);
  return role ? LINEUPS[lineup][role] : modelId;
}

/** If a role's provider fails, the same role in the other lineup takes over (chosen models have none). */
export function fallbackFor(modelId: string, lineup: Lineup): string | null {
  const role = roleOf(modelId);
  return role ? LINEUPS[lineup === "anthropic" ? "openai" : "anthropic"][role] : null;
}

/**
 * How hard each model family thinks, as provider options: Haiku without
 * thinking (speed), Sonnet at medium, Opus at high; OpenAI's Luna low, Sol
 * medium, Astra high. Other models keep their provider's defaults.
 */
export function modelSettings(modelId: string): Record<string, Record<string, unknown>> {
  const [provider, name = ""] = modelId.split("/");
  if (provider === "anthropic") {
    if (name.startsWith("claude-haiku-5")) return { anthropic: { thinking: { type: "disabled" } } };
    if (name.startsWith("claude-sonnet-5")) return { anthropic: { thinking: { type: "adaptive" }, effort: "medium" } };
    if (name.startsWith("claude-opus-5")) return { anthropic: { effort: "high" } };
  }
  if (provider === "openai") {
    if (/^gpt-[\d.]+-luna/.test(name)) return { openai: { reasoningEffort: "low" } };
    if (/^gpt-[\d.]+-sol/.test(name)) return { openai: { reasoningEffort: "medium" } };
    if (/^gpt-[\d.]+-astra/.test(name)) return { openai: { reasoningEffort: "high" } };
  }
  return {};
}
