import "server-only";

import { transcribe, type TranscriptionModel } from "ai";

// Voice messages: recorded in the app (the Chief of Staff chat, a task's reply
// box) or sent as a WhatsApp voice note, and turned into text through AI
// Gateway, billed to its credits like the rest. TRANSCRIPTION_MODEL picks the
// model (OpenAI's gpt-4o-mini-transcribe by default).

/** Larger recordings aren't transcribed (a few minutes of speech is well under this). */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export class TranscriptionError extends Error {}

export async function transcribeAudio(audio: Uint8Array, options: { model?: TranscriptionModel } = {}): Promise<string> {
  if (audio.length === 0) throw new TranscriptionError("That recording is empty.");
  if (audio.length > MAX_AUDIO_BYTES) throw new TranscriptionError("That recording is too long to transcribe. Keep it under a few minutes.");
  const model = options.model ?? process.env.TRANSCRIPTION_MODEL ?? "openai/gpt-4o-mini-transcribe";
  const { text } = await transcribe({ model, audio });
  return text.trim();
}
