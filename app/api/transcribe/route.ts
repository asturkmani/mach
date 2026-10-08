import { getSessionContext } from "@/lib/session";
import { MAX_AUDIO_BYTES, transcribeAudio, TranscriptionError } from "@/lib/transcribe";

// A voice message recorded in the app, sent as the request body, comes back
// as text for the person to check before they send it.
export const maxDuration = 60;

export async function POST(request: Request) {
  const context = await getSessionContext();
  if (!context.organization) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(request.headers.get("content-type") ?? "").startsWith("audio/")) {
    return Response.json({ error: "Send the recording as audio." }, { status: 400 });
  }
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) return Response.json({ error: "That recording is too long." }, { status: 413 });
  try {
    return Response.json({ text: await transcribeAudio(audio) });
  } catch (error) {
    if (error instanceof TranscriptionError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Transcription failed", error);
    return Response.json({ error: "Couldn't transcribe that. Try again, or type it." }, { status: 502 });
  }
}
