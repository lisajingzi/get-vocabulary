"use client";

/**
 * <SpeakButton /> — speaks an English word/phrase aloud.
 *
 * Strategy (tries in order, shows toast on failure — never falls back to
 * the robotic Web Speech API, per product decision):
 *   1. **Word / short phrase** → YouDao MP3
 *      `https://dict.youdao.com/dictvoice?audio=<text>&type=<1|2>`
 *      Real human recordings, free, no API key. type=1 = UK, type=2 = US.
 *      Best quality for single words and common phrases.
 *   2. **Sentence** → local IndexedDB cache → `/api/tts` (Edge Neural TTS,
 *      voice=en-US-JennyNeural, server retries once internally). Cached
 *      MP3s replay instantly and offline.
 *   3. **On failure** → toast "朗读失败，请稍后重试". No mechanical fallback.
 *
 * Implementation notes:
 *   - We reuse a single <Audio> element to avoid GC churn.
 *   - YouDao only reliably has recordings for words/short phrases. Anything
 *     with >6 tokens or >60 chars is treated as a sentence and skips YouDao.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getCachedTTS, putCachedTTS } from "@/lib/tts/cache";
import { toast } from "@/components/Toast";

interface Props {
  text: string;
  /** "uk" prefers en-GB voices; "us" prefers en-US. Falls back to any en-*. */
  variant?: "uk" | "us";
  /** Optional ARIA label, shown via title; otherwise auto-derived. */
  title?: string;
  className?: string;
  children?: React.ReactNode;
}

const YOUDAO_BASE = "https://dict.youdao.com/dictvoice";

/** Neural voices for our /api/tts endpoint. */
const NEURAL_VOICE_US = "en-US-JennyNeural";
const NEURAL_VOICE_UK = "en-GB-SoniaNeural";

function buildYouDaoUrl(text: string, variant: "uk" | "us"): string {
  // type=1 → UK English, type=2 → US English
  const type = variant === "uk" ? 1 : 2;
  return `${YOUDAO_BASE}?audio=${encodeURIComponent(text)}&type=${type}`;
}

/** Heuristic: very long sentences are unlikely to have a YouDao recording. */
function shouldSkipYouDao(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const tokens = trimmed.split(/\s+/);
  return tokens.length > 6 || trimmed.length > 60;
}

/** Show a user-facing failure toast. Kept in one place so wording is consistent. */
function notifyFailure() {
  toast("朗读失败，请稍后重试");
}

/** Fetch MP3 bytes from /api/tts. Returns null on any failure. */
async function fetchNeuralMP3(
  text: string,
  voice: string,
): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export default function SpeakButton({
  text,
  variant = "us",
  title,
  className,
  children,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track blob URLs we mint so we can revoke them and avoid a memory leak
  // when the component unmounts or plays a different sentence.
  const blobUrlRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Clean up the last blob URL when unmounting so we don't leak.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  /** Play a Blob (MP3) through the shared <audio> element. */
  const playBlob = useCallback((blob: Blob) => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    // Revoke the previous URL, if any, before minting a new one.
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
    }
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    const audio = audioRef.current;
    audio.pause();

    // Wire an error handler so a malformed MP3 doesn't fail silently.
    const onError = () => {
      console.warn(
        `[tts] audio playback error (mediaError=${audio.error?.code ?? "?"})`,
      );
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("error", onError, { once: true });

    audio.src = url;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.warn("[tts] audio.play() rejected:", err?.message ?? err);
      });
    }
  }, []);

  const speak = useCallback(async () => {
    if (typeof window === "undefined") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Cancel any lingering Web Speech utterance from earlier versions of
    // the app — cheap safety net, doesn't hurt if none is queued.
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    // ── Word / short phrase → YouDao real-human recording ───────────────
    if (!shouldSkipYouDao(trimmed)) {
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.preload = "auto";
      }
      const audio = audioRef.current;
      // If the previous src was a blob URL, revoke it before overwriting.
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      audio.pause();
      audio.src = buildYouDaoUrl(trimmed, variant);

      const onError = () => {
        cleanup();
        console.warn(`[tts] YouDao playback failed for: "${trimmed}"`);
        notifyFailure();
      };
      const cleanup = () => {
        audio.removeEventListener("error", onError);
      };
      audio.addEventListener("error", onError, { once: true });

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise.catch((err) => {
          cleanup();
          console.warn(
            `[tts] YouDao play() rejected: ${err?.message ?? err}`,
          );
          notifyFailure();
        });
      }
      return;
    }

    // ── Sentence → IndexedDB cache → /api/tts → toast on failure ────────
    const neuralVoice =
      variant === "uk" ? NEURAL_VOICE_UK : NEURAL_VOICE_US;
    const preview = trimmed.slice(0, 40);

    // 1. Try local cache first — instant, offline-capable.
    const cached = await getCachedTTS(neuralVoice, trimmed);
    if (cached) {
      console.debug(`[tts] cache hit (${neuralVoice}): "${preview}..."`);
      playBlob(cached);
      return;
    }

    // 2. Fetch from /api/tts (server retries once internally). Show a busy
    //    indicator so the user knows something is happening — cold requests
    //    can take 1-2s, and up to ~16s in the retry-worst-case.
    console.debug(`[tts] cache miss, fetching /api/tts: "${preview}..."`);
    setBusy(true);
    try {
      const bytes = await fetchNeuralMP3(trimmed, neuralVoice);
      if (bytes && bytes.byteLength > 0) {
        console.debug(
          `[tts] /api/tts ok (${bytes.byteLength}B), playing: "${preview}..."`,
        );
        // Persist for next time (best effort — ignore failures).
        void putCachedTTS(neuralVoice, trimmed, bytes.slice(0));
        playBlob(new Blob([bytes], { type: "audio/mpeg" }));
        return;
      }
      // 3. Neural TTS still unreachable after server-side retry → toast.
      //    We deliberately do NOT fall back to Web Speech (mechanical voice).
      console.warn(`[tts] /api/tts failed after retries: "${preview}..."`);
      notifyFailure();
    } finally {
      setBusy(false);
    }
  }, [text, variant, playBlob]);

  return (
    <button
      type="button"
      onClick={speak}
      disabled={busy}
      title={title ?? `朗读 (${variant === "uk" ? "英" : "美"}音)`}
      className={
        className ??
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--fg-soft)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--accent)] disabled:cursor-progress disabled:opacity-60"
      }
      aria-label={`朗读 ${text}`}
      aria-busy={busy || undefined}
    >
      {children ?? (busy ? "…" : "🔊")}
    </button>
  );
}
