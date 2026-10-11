import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { decide, type Question } from "@/lib/ai/decide";
import { getDb } from "@/lib/db";

// Decisions inside skills (docs/agent-design.md): a skill's scripts ask
// mach.decide which tag, which entity, is this a repeat. The question goes to
// Jev with the closest past cases and their final answers in its state, so a
// correction made last week counts this week; nothing is trained. Whether an
// answer is applied without asking anyone comes from a backtest on the
// answers people confirmed or changed, never from a number a model states
// about itself. Every decision is kept, with what happened to it.

/** Jev's Choice takes up to this many options; with more, code narrows them first. */
const MAX_OPTIONS = 255;
/** Past cases in a decision's state. */
const PAST_CASES = 10;
/** People's answers a backtest needs before anything is applied automatically. */
const MIN_JUDGED = 20;
/** Decisions one job may ask for in a day. */
const DAILY_BUDGET = 5000;
export const NONE = "none of these";

// ---------------------------------------------------------------------------
// The run token: the sandbox's network proxy adds it to requests to Mach1, so
// a job's scripts can ask for decisions without holding a key.

const TTL_MS = 12 * 60 * 60_000;

function key(): Buffer {
  const raw = process.env.MACH_SECRETS_KEY;
  if (!raw) throw new Error("Set MACH_SECRETS_KEY to sign run tokens.");
  return createHmac("sha256", Buffer.from(raw, "base64")).update("run-tokens").digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

export function runToken(organizationId: string, taskId: string, now = Date.now()): string {
  const payload = `${organizationId}.${taskId}.${now + TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

export function readRunToken(token: string, now = Date.now()): { organizationId: string; taskId: string } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [organizationId, taskId, expires] = payload.split(".");
  if (!organizationId || !taskId || !(Number(expires) > now)) return null;
  return { organizationId, taskId };
}

// ---------------------------------------------------------------------------

export type AskedQuestion = {
  /** A choice unless it says boolean. */
  type?: "choice" | "boolean";
  instructions: string;
  /** For a choice: the options, fetched fresh each run (a list, or names with what each means). */
  options?: string[] | Record<string, string | null>;
};

export type DecisionRequest = {
  skill: string;
  /** Facts from code: numbers and dates already turned into plain statements. */
  state: string;
  questions: Record<string, AskedQuestion>;
  /** What makes cases alike, e.g. the counterparty: its past cases come first. */
  key?: string;
  /** How often an automatic answer must be right, e.g. 0.98. Without one, nothing is automatic. */
  target?: number;
};

export type DecisionAnswer = {
  id: string;
  choice?: string;
  probability: number;
  probabilities?: Record<string, number>;
  /** Apply it without asking: above the backtested threshold for the target. */
  auto: boolean;
  threshold: number | null;
};

export class DecisionError extends Error {}

type Past = { state: string; key: string | null; final: string; choice: string | null; probability: number; outcome: string | null };

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length / Math.max(1, Math.min(a.size, b.size));

/** The closest past cases with their final answers: the same key first, then the most alike. */
export function nearest(past: Past[], state: string, key: string | undefined, n = PAST_CASES): Past[] {
  const mine = words(state);
  return [...past]
    .map((p) => ({ p, score: (key && p.key === key ? 10 : 0) + overlap(mine, words(p.state)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.p);
}

/**
 * The lowest threshold at which automatic answers would have been right at
 * least `target` of the time, on the answers people confirmed or changed; null
 * when there aren't enough of them, or no threshold gets there.
 */
export function backtest(judged: { probability: number; correct: boolean }[], target: number): number | null {
  if (judged.length < MIN_JUDGED) return null;
  const sorted = [...judged].sort((a, b) => b.probability - a.probability);
  let best: number | null = null;
  let right = 0;
  for (const [i, d] of sorted.entries()) {
    if (d.correct) right++;
    const count = i + 1;
    // A threshold only counts once enough answers sit above it.
    if (count >= MIN_JUDGED && right / count >= target) best = d.probability;
  }
  return best;
}

/** Narrows a long option list: this key's past answers, then those of the nearest cases, then the rest in order. */
function narrow(options: Record<string, string | null>, past: Past[]): Record<string, string | null> {
  const names = Object.keys(options);
  if (names.length < MAX_OPTIONS) return options;
  const likely = [...new Set(past.map((p) => p.final))].filter((n) => n in options);
  const kept = [...new Set([...likely, ...names])].slice(0, MAX_OPTIONS - 1);
  return Object.fromEntries(kept.map((n) => [n, options[n]]));
}

async function history(organizationId: string, skill: string, question: string): Promise<Past[]> {
  return getDb().query<Past>(
    `select state, key, final, choice, probability, outcome from skill_decisions
     where organization_id = $1 and skill = $2 and question = $3 and final is not null order by created_at desc limit 500`,
    [organizationId, skill, question],
  );
}

/** Answers a skill's questions about one state, and keeps each decision. */
export async function decideForSkill(organizationId: string, taskId: string, request: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
  const entries = Object.entries(request.questions);
  if (!entries.length) throw new DecisionError("Ask at least one question.");
  if (!request.state.trim()) throw new DecisionError("Give the facts to decide from (state).");
  const [{ used }] = await getDb().query<{ used: number }>(
    "select count(*)::int as used from skill_decisions where task_id = $1 and created_at > now() - interval '1 day'",
    [taskId],
  );
  if (used + entries.length > DAILY_BUDGET) throw new DecisionError(`This job has asked for ${used} decisions today, its limit. Send the rest to people.`);

  const pasts = Object.fromEntries(await Promise.all(entries.map(async ([id]) => [id, await history(organizationId, request.skill, id)] as const)));
  const questions: Record<string, Question> = {};
  const offered: Record<string, string[]> = {};
  for (const [id, q] of entries) {
    if (q.type === "boolean") {
      questions[id] = { type: "boolean", instructions: q.instructions };
      continue;
    }
    const raw = Array.isArray(q.options) ? Object.fromEntries(q.options.map((o) => [o, null])) : (q.options ?? {});
    if (!Object.keys(raw).length) throw new DecisionError(`${id} needs its options.`);
    // There's always a way out: none of the options fits.
    const criteria = { ...narrow(raw, nearest(pasts[id], request.state, request.key, 50)), [NONE]: "None of these fits" };
    questions[id] = { type: "choice", instructions: q.instructions, criteria };
    offered[id] = Object.keys(criteria);
  }
  // Past cases go into the state with their final answers: that's how it "knows" this counterparty.
  const cases = entries.flatMap(([id]) =>
    nearest(pasts[id], request.state, request.key).map((p) => `- ${p.key ? `${p.key}: ` : ""}${p.state.slice(0, 400)} → ${id}: ${p.final}`),
  );
  const state = cases.length ? `${request.state}\n\nPast cases and the answers that stood:\n${cases.join("\n")}` : request.state;
  const { answers, model } = await decide(organizationId, state, questions);

  const result: Record<string, DecisionAnswer> = {};
  for (const [id] of entries) {
    const answer = answers[id];
    const judged = pasts[id].filter((p) => p.outcome).map((p) => ({ probability: p.probability, correct: p.choice === p.final }));
    const threshold = request.target ? backtest(judged, request.target) : null;
    const choice = answer.type === "choice" ? answer.choice : undefined;
    const probability = answer.type === "choice" ? (answer.probabilities[answer.choice] ?? 0) : answer.probability;
    const auto = threshold !== null && probability >= threshold && choice !== NONE;
    const [row] = await getDb().query<{ id: string }>(
      `insert into skill_decisions (organization_id, task_id, skill, question, key, state, options, choice, probability, probabilities, threshold, auto, model, final)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14) returning id`,
      [
        organizationId,
        taskId,
        request.skill,
        id,
        request.key ?? null,
        request.state,
        JSON.stringify(offered[id] ?? []),
        choice ?? (probability >= 0.5 ? "yes" : "no"),
        probability,
        JSON.stringify(answer.type === "choice" ? answer.probabilities : { yes: answer.probability }),
        threshold,
        auto,
        model,
        auto ? (choice ?? null) : null,
      ],
    );
    result[id] = {
      id: row.id,
      ...(choice !== undefined ? { choice, probabilities: answer.type === "choice" ? answer.probabilities : undefined } : {}),
      probability,
      auto,
      threshold,
    };
  }
  return result;
}

/** What happened to a decision: a person confirmed it or changed it. It goes into the history the next ones learn from. */
export async function recordOutcome(organizationId: string, decisionId: string, final: string, by: string): Promise<"confirmed" | "changed"> {
  const [row] = await getDb().query<{ choice: string | null }>("select choice from skill_decisions where organization_id = $1 and id = $2", [
    organizationId,
    decisionId,
  ]);
  if (!row) throw new DecisionError("There's no such decision.");
  const outcome = row.choice === final ? "confirmed" : "changed";
  await getDb().query(
    "update skill_decisions set outcome = $3, final = $4, decided_by = $5, decided_at = now() where organization_id = $1 and id = $2",
    [organizationId, decisionId, outcome, final, by],
  );
  return outcome;
}
