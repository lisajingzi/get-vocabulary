"use client";

/**
 * <SpeakButton /> — speaks an English word/phrase aloud.
 *
 * Strategy (tries in order, falls back on failure):
 *   1. **YouDao MP3** — `https://dict.youdao.com/dictvoice?audio=<text>&type=<1|2>`
 *      Real human recordings, free, no API key. type=1 = UK, type=2 = US.
 *      Best quality for single words and common phrases.
 *   2. **Web Speech API** — system TTS as a robust fallback
 *      (used for offline, network errors, or sentences too long for the
 *      YouDao endpoint to have a recording for).
 *
 * Implementation notes:
 *   - We reuse a single <Audio> element to avoid GC churn.
 *   - YouDao only reliably has recordings for words/short phrases. For
 *     anything containing whitespace longer than ~6 tokens we go straight
 *     to TTS — saves a wasted round-trip.
 *   - SpeechSynthesis voice picking still uses voiceschanged event so
 *     Chrome's lazy voice list works.
 */

import { useCallback, useEffect, useRef } from "react";

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

function pickVoice(
  voices: SpeechSynthesisVoice[],
  variant: "uk" | "us",
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const wantPrefix = variant === "uk" ? "en-GB" : "en-US";
  const exact = voices.find((v) => v.lang === wantPrefix);
  if (exact) return exact;
  const prefix = voices.find((v) => v.lang.startsWith(wantPrefix.slice(0, 2)));
  return prefix ?? voices[0];
}

function speakViaTTS(text: string, variant: "uk" | "us", voice: SpeechSynthesisVoice | null) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (!text.trim()) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = variant === "uk" ? "en-GB" : "en-US";
  utt.rate = 0.95;
  if (voice) utt.voice = voice;
  window.speechSynthesis.speak(utt);
}

export default function SpeakButton({
  text,
  variant = "us",
  title,
  className,
  children,
}: Props) {
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const update = () => {
      voiceRef.current = pickVoice(
        window.speechSynthesis.getVoices(),
        variant,
      );
    };
    update();
    window.speechSynthesis.onvoiceschanged = update;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [variant]);

  const speak = useCallback(() => {
    if (typeof window === "undefined") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Cancel any pending TTS so playback feels snappy when hammered.
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    // Long sentence → skip YouDao, go straight to system TTS.
    if (shouldSkipYouDao(trimmed)) {
      speakViaTTS(trimmed, variant, voiceRef.current);
      return;
    }

    // Try YouDao real-human MP3 first.
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    const audio = audioRef.current;
    audio.pause();
    audio.src = buildYouDaoUrl(trimmed, variant);

    const onError = () => {
      cleanup();
      speakViaTTS(trimmed, variant, voiceRef.current);
    };
    const cleanup = () => {
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("error", onError, { once: true });

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.catch(() => {
        cleanup();
        speakViaTTS(trimmed, variant, voiceRef.current);
      });
    }
  }, [text, variant]);

  return (
    <button
      type="button"
      onClick={speak}
      title={title ?? `朗读 (${variant === "uk" ? "英" : "美"}音)`}
      className={
        className ??
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--fg-soft)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--accent)]"
      }
      aria-label={`朗读 ${text}`}
    >
      {children ?? "🔊"}
    </button>
  );
}
