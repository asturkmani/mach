"use client";

import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useShell } from "@/components/shell/shell";

// A voice message: record, and the words land in the message box to check
// before sending. The recording goes to /api/transcribe and isn't kept.

/** Long enough for a thought, short enough to stay well under the upload limit. */
const MAX_SECONDS = 5 * 60;

function pickType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
}

export function VoiceButton({ onText, className = "" }: { onText: (text: string) => void; className?: string }) {
  const { toast } = useShell();
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);

  const stop = (cancel = false) => {
    cancelled.current = cancel;
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  // Count while recording, stop at the limit, and Esc throws the recording away.
  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [state]);

  // Leaving the page mid-recording lets go of the microphone.
  useEffect(() => () => stop(true), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return toast("This browser can't record audio.");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast("Mach1 needs your microphone for voice messages. Allow it in the browser and try again.");
    }
    const mimeType = pickType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      if (cancelled.current || !chunks.length) return setState("idle");
      setState("transcribing");
      const audio = new Blob(chunks, { type: (rec.mimeType || mimeType || "audio/webm").split(";")[0] });
      try {
        const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": audio.type }, body: audio });
        const result = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
        if (result.text) onText(result.text);
        else toast(result.error ?? (result.text === "" ? "Didn't catch any words. Try again." : "Couldn't transcribe that. Try again, or type it."));
      } catch {
        toast("Couldn't reach Mach1 to transcribe that. Try again.");
      } finally {
        setState("idle");
      }
    };
    recorder.current = rec;
    cancelled.current = false;
    setSeconds(0);
    rec.start(1000);
    setState("recording");
  };

  if (state === "transcribing") {
    return (
      <span className={`flex items-center gap-1.5 text-xs text-muted ${className}`} role="status">
        <LoaderCircle size={15} className="animate-spin" />
        <span className="hidden sm:inline">Transcribing</span>
      </span>
    );
  }
  if (state === "recording") {
    return (
      <button
        type="button"
        onClick={() => stop()}
        aria-label="Stop recording"
        title="Stop recording (Esc to throw it away)"
        className={`flex items-center gap-1.5 text-xs text-warn ${className}`}
      >
        <span className="size-2 animate-pulse rounded-full bg-[currentColor]" />
        <span className="font-mono tabular-nums">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
        <Square size={13} />
      </button>
    );
  }
  return (
    <button type="button" onClick={start} aria-label="Record a voice message" title="Record a voice message" className={className}>
      <Mic size={15} />
    </button>
  );
}

/** Adds dictated text to what's already typed, on its own line if there's something there. */
export function appendDictation(current: string, text: string): string {
  const before = current.trimEnd();
  return before ? `${before}\n${text}` : text;
}
