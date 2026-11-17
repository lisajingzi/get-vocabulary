"use client";

/**
 * <SpeakButton /> — speaks an English word/phrase aloud.
 *
 * Strategy (tries in order; sentences fall back to Web Speech as a
 * last resort to avoid silence; short words/phrases do not — YouDao
 * already covers them well and Web Speech sounds worse than YouDao):
 *   1. **Word / short phrase** → YouDao MP3
 *      `https://dict.youdao.com/dictvoice?audio=<text>&type=<1|2>`
 *      Real human recordings, free, no API key. type=1 = UK, type=2 = US.
 *      Best quality for single words and common phrases.
 *   2a. **YouDao load failed** (no recording for this text, network error,
 *       or unsupported MIME) → silently fall back to Edge Neural TTS.
 *       This catches short *sentences* like "to run for election" that
 *       look like phrases token-wise but have no YouDao recording.
 *   2b. **Sentence** (long text, > 6 tokens or > 60 chars) → skip YouDao
 *       entirely, go straight to Edge Neural.
 *   3. **Edge Neural** → local IndexedDB cache → `/api/tts` (voice=Jenny
 *      or Sonia, client retries 3× with jittered backoff). Cached MP3s
 *      replay instantly and offline.
 *   4. **Sentence Neural failed** → Web Speech API (robotic but always
 *      available). Only used for long text — words stop at step 3.
 *   5. **Everything failed** → toast "朗读失败，请稍后重试".
 *
 * Implementation notes:
 *   - We reuse a single <Audio> element to avoid GC churn.
 *   - YouDao is optimistic-first: we try it for any short text because
 *     when it has a recording, the quality is much better than Neural TTS.
 *     When it fails we fall through to Neural, so the user never notices.
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

/**
 * Fetch MP3 bytes from /api/tts with client-side retry.
 *
 * `/api/tts` fronts Bing edge-tts and sporadically returns 502 when the
 * server-side WSS handshake fails. Retrying from the client uses a fresh
 * TCP connection and a different time window; combined with a jittered
 * backoff this reliably rescues most upstream flakes.
 */
async function fetchNeuralMP3(
  text: string,
  voice: string,
): Promise<ArrayBuffer | null> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0) return buf;
      }
      // 4xx (except 408/429) is terminal — no point retrying bad input.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.warn(
          `[tts] /api/tts terminal status ${res.status}, not retrying`,
        );
        return null;
      }
      console.warn(
        `[tts] /api/tts attempt ${attempt}/${MAX_ATTEMPTS} failed (status=${res.status})`,
      );
    } catch (e) {
      console.warn(
        `[tts] /api/tts attempt ${attempt}/${MAX_ATTEMPTS} threw:`,
        e instanceof Error ? e.message : e,
      );
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = 400 * attempt + Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}

/**
 * Last-resort fallback for long text (sentences / phrases that YouDao
 * can't pronounce): the browser's built-in Web Speech API. Audio quality
 * is clearly worse than Neural TTS but guarantees non-silence when
 * /api/tts is down.
 *
 * We intentionally do NOT use this for single words — YouDao already
 * covers those well, and a Web Speech word reading sounds noticeably
 * worse than a YouDao recording.
 */
function speakWithWebSpeech(text: string, variant: "uk" | "us"): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return false;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = variant === "uk" ? "en-GB" : "en-US";
    u.rate = 1;
    window.speechSynthesis.speak(u);
    return true;
  } catch (e) {
    console.warn("[tts] Web Speech fallback threw:", e);
    return false;
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

  /**
   * Play `trimmed` through the Edge Neural TTS pipeline.
   * Returns true on success, false on failure. Caller decides whether to
   * toast / fall back further — we never toast in here so this function
   * can be used as a silent fallback from the YouDao branch.
   */
  const playNeuralTTS = useCallback(
    async (trimmed: string): Promise<boolean> => {
      const neuralVoice =
        variant === "uk" ? NEURAL_VOICE_UK : NEURAL_VOICE_US;
      const preview = trimmed.slice(0, 40);

      // 1. Try local cache first — instant, offline-capable.
      const cached = await getCachedTTS(neuralVoice, trimmed);
      if (cached) {
        console.debug(`[tts] cache hit (${neuralVoice}): "${preview}..."`);
        playBlob(cached);
        return true;
      }

      // 2. Fetch from /api/tts (with client-side retries). Show a busy
      //    indicator so the user knows something is happening — cold
      //    requests can take 1–2s, and up to ~10s in the retry-worst-case.
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
          return true;
        }
        console.warn(`[tts] /api/tts failed after retries: "${preview}..."`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [variant, playBlob],
  );

  const speak = useCallback(async () => {
    if (typeof window === "undefined") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Cancel any lingering Web Speech utterance from earlier versions of
    // the app — cheap safety net, doesn't hurt if none is queued.
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    // ── Word / short phrase → try YouDao first, fall back to Neural ─────
    // YouDao has real human recordings for words and common phrases, but
    // NOT for short sentences that just happen to be under 6 tokens (e.g.
    // "to run for election"). When YouDao 404s / returns unsupported MIME,
    // we silently retry via Edge Neural TTS so the user never sees a toast
    // for something we can actually pronounce.
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

      // Guard so we only fall back once even if both `error` and the
      // play() promise reject fire.
      let fellBack = false;
      const fallback = async (reason: string) => {
        if (fellBack) return;
        fellBack = true;
        audio.removeEventListener("error", onError);
        console.warn(
          `[tts] YouDao failed (${reason}) for "${trimmed}", falling back to Edge Neural`,
        );
        const ok = await playNeuralTTS(trimmed);
        if (!ok) notifyFailure();
      };
      const onError = () => {
        void fallback(
          `mediaError=${audio.error?.code ?? "?"} (${audio.error?.message ?? "no source"})`,
        );
      };
      audio.addEventListener("error", onError, { once: true });

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise.catch((err) => {
          void fallback(`play() rejected: ${err?.message ?? err}`);
        });
      }
      return;
    }

    // ── Sentence → Edge Neural directly → Web Speech fallback → toast ──
    // For long text, if Neural fails (upstream /api/tts flake) we fall
    // back to the browser's Web Speech API so the user hears *something*
    // instead of a silent toast. We only toast if even Web Speech is
    // unavailable / fails to start.
    const ok = await playNeuralTTS(trimmed);
    if (ok) return;
    console.warn(
      `[tts] Neural failed for sentence, falling back to Web Speech: "${trimmed.slice(0, 40)}..."`,
    );
    const spoke = speakWithWebSpeech(trimmed, variant);
    if (!spoke) notifyFailure();
  }, [text, variant, playNeuralTTS]);

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
