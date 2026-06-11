"use client";

/**
 * <SpeakButton /> — fire-and-forget Web Speech API wrapper.
 *
 * Why not <audio src=…>? — The Oxford mdx ships pronunciation audio inside
 * a separate `.mdd` resource pack we have not unpacked. Until we do (post-V1),
 * the browser's native speechSynthesis is good enough and ships zero bytes.
 *
 * Implementation notes:
 *   - Some browsers (Chrome) only populate `getVoices()` after a `voiceschanged`
 *     event. We pick the best voice once on mount and cache it.
 *   - We always cancel any in-flight utterance before starting a new one so
 *     hammering the button doesn't queue up a backlog.
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

export default function SpeakButton({
  text,
  variant = "us",
  title,
  className,
  children,
}: Props) {
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

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
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (!text.trim()) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = variant === "uk" ? "en-GB" : "en-US";
    utt.rate = 0.95; // slight slowdown helps language-learner comprehension
    if (voiceRef.current) utt.voice = voiceRef.current;
    window.speechSynthesis.speak(utt);
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
