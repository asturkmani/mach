import "server-only";

import { gateway } from "ai";

// The language models AI Gateway offers, to choose one for an agent. Empty
// when the gateway can't be reached (the field still takes any id).

export type ModelChoice = { id: string; name: string };

let cached: { at: number; models: ModelChoice[] } | null = null;
const FRESH_MS = 60 * 60_000;

export async function modelChoices(): Promise<ModelChoice[]> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.models;
  try {
    const { models } = await Promise.race([
      gateway.getAvailableModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI Gateway didn't answer")), 5000)),
    ]);
    const choices = models
      .filter((m) => !m.modelType || m.modelType === "language")
      .map((m) => ({ id: m.id, name: m.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    cached = { at: Date.now(), models: choices };
    return choices;
  } catch (error) {
    console.error("Couldn't list AI Gateway's models", (error as Error).message);
    return [];
  }
}
