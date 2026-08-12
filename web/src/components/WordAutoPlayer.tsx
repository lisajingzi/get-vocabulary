"use client";

/**
 * <WordAutoPlayer /> — auto-plays a list of words one by one.
 *
 * Purpose: on /wordbook, the user asked for a "just play everything on
 * this page" mode. This component owns:
 *   - speed selector (0.8x / 1x / 1.2x / 1.4x)   → audio.playbackRate
 *   - gap selector (1s / 3s / 5s / 6s)           → setTimeout between words
 *   - play / pause (resume) / restart controls
 *
 * Strategy:
 *   - Try YouDao MP3 first (short single words → high hit rate).
 *   - On any error/load failure, fall back silently to /api/tts (Neural).
 *   - When a word ends, wait `gap` ms then advance to the next.
 *   - Pause = clear the pending timeout + audio.pause(); resume picks up
 *     from the same cursor.
 *   - Restart = cursor back to 0 and immediately begin from the top.
 *
 * The parent tells us the *current visible page* of words. If that list
 * changes (user flipped page, changed filter), we stop playing — trying
 * to reconcile an ongoing playback against a shifting queue is a rabbit
 * hole the user doesn't need.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCachedTTS, putCachedTTS } from "@/lib/tts/cache";

interface Props {
  /** Words on the current visible page (in list order). */
  words: string[];
  /** Called with the currently-playing lemma so parent can highlight it.
   *  null = nothing playing. */
  onCurrentChange?: (lemma: string | null) => void;
}

type Phase = "idle" | "playing" | "paused";

const SPEED_OPTIONS = [0.8, 1, 1.2, 1.4] as const;
const GAP_OPTIONS_MS = [1000, 3000, 5000, 6000] as const;

const YOUDAO_BASE = "https://dict.youdao.com/dictvoice";
const NEURAL_VOICE_US = "en-US-JennyNeural";

function youdaoUrl(text: string): string {
  return `${YOUDAO_BASE}?audio=${encodeURIComponent(text)}&type=2`;
}

async function fetchNeuralMP3(text: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: NEURAL_VOICE_US }),
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export default function WordAutoPlayer({ words, onCurrentChange }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [speed, setSpeed] = useState<number>(1);
  const [gapMs, setGapMs] = useState<number>(3000);

  // Refs so async callbacks always read the latest values without needing
  // to be re-created on every state change.
  const cursorRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const speedRef = useRef(speed);
  const gapRef = useRef(gapMs);
  const wordsRef = useRef(words);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    speedRef.current = speed;
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    gapRef.current = gapMs;
  }, [gapMs]);

  // If the visible list changes (filter / page flip), stop playback so we
  // don't end up chasing a phantom cursor into the wrong list.
  useEffect(() => {
    const prev = wordsRef.current;
    const changed =
      prev.length !== words.length ||
      prev.some((w, i) => w !== words[i]);
    wordsRef.current = words;
    if (changed && phaseRef.current !== "idle") {
      stopAll();
      setPhase("idle");
      cursorRef.current = 0;
      onCurrentChange?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words]);

  // Cleanup on unmount — kill audio + pending timers + blob URLs.
  useEffect(() => {
    return () => {
      stopAll();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopAll() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
    }
  }

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  }, []);

  /** Play a Blob (MP3) and resolve when it ends. Rejects on error. */
  const playBlob = useCallback(
    (blob: Blob): Promise<void> => {
      return new Promise((resolve, reject) => {
        const audio = ensureAudio();
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("audio error"));
        audio.src = url;
        audio.playbackRate = speedRef.current;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(reject);
        }
      });
    },
    [ensureAudio],
  );

  /** Play a URL directly. Resolves on `ended`, rejects on error/load-fail. */
  const playUrl = useCallback(
    (url: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const audio = ensureAudio();
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("audio error"));
        audio.src = url;
        audio.playbackRate = speedRef.current;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(reject);
        }
      });
    },
    [ensureAudio],
  );

  /** Play a single word to completion, using YouDao → Neural fallback. */
  const speakWord = useCallback(
    async (word: string): Promise<void> => {
      // Try YouDao first.
      try {
        await playUrl(youdaoUrl(word));
        return;
      } catch {
        // fall through
      }
      // Try Neural cache.
      const cached = await getCachedTTS(NEURAL_VOICE_US, word);
      if (cached) {
        try {
          await playBlob(cached);
          return;
        } catch {
          // fall through
        }
      }
      // Fetch Neural.
      const bytes = await fetchNeuralMP3(word);
      if (bytes && bytes.byteLength > 0) {
        void putCachedTTS(NEURAL_VOICE_US, word, bytes.slice(0));
        await playBlob(new Blob([bytes], { type: "audio/mpeg" }));
      }
      // If everything failed, silently skip so the queue keeps moving.
    },
    [playUrl, playBlob],
  );

  /** The core loop: play the current word, wait `gap`, advance. */
  const step = useCallback(async () => {
    const list = wordsRef.current;
    if (phaseRef.current !== "playing") return;
    const i = cursorRef.current;
    if (i >= list.length) {
      // Finished the whole page.
      setPhase("idle");
      cursorRef.current = 0;
      onCurrentChange?.(null);
      return;
    }
    const word = list[i];
    onCurrentChange?.(word);
    try {
      await speakWord(word);
    } catch {
      // Failure is silent — advance anyway so the user isn't stuck.
    }
    if (phaseRef.current !== "playing") return;
    // Gap → next.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      cursorRef.current = i + 1;
      void step();
    }, gapRef.current);
  }, [speakWord, onCurrentChange]);

  const handlePlay = useCallback(() => {
    if (phase === "playing") return;
    if (wordsRef.current.length === 0) return;
    setPhase("playing");
    phaseRef.current = "playing";
    void step();
  }, [phase, step]);

  const handlePause = useCallback(() => {
    if (phase !== "playing") return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (audioRef.current) audioRef.current.pause();
    setPhase("paused");
    phaseRef.current = "paused";
    // Keep the currently-highlighted word — user knows where they are.
  }, [phase]);

  const handleResume = useCallback(() => {
    if (phase !== "paused") return;
    setPhase("playing");
    phaseRef.current = "playing";
    // Resume by restarting the current word from the top of its clip.
    // (Simpler than resuming mid-audio, and the user hears the pause point
    //  contextually re-anchored.)
    void step();
  }, [phase, step]);

  const handleRestart = useCallback(() => {
    stopAll();
    cursorRef.current = 0;
    setPhase("playing");
    phaseRef.current = "playing";
    void step();
  }, [step]);

  const total = words.length;
  const disabled = total === 0;

  const cursorLabel = useMemo(() => {
    if (phase === "idle") return `${total} 个`;
    const c = Math.min(cursorRef.current + 1, total);
    return `${c} / ${total}`;
  }, [phase, total]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-soft)]/40 px-3 py-2 text-xs">
      <span className="font-medium text-[var(--fg)]">自动播放</span>
      <span className="text-[var(--fg-soft)]">·</span>
      <span className="tabular-nums text-[var(--fg-soft)]">{cursorLabel}</span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-[var(--fg-soft)]">
          速度
          <select
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--fg)] outline-none"
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                x{s}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-[var(--fg-soft)]">
          间隔
          <select
            value={gapMs}
            onChange={(e) => setGapMs(parseInt(e.target.value, 10))}
            className="rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[var(--fg)] outline-none"
          >
            {GAP_OPTIONS_MS.map((g) => (
              <option key={g} value={g}>
                {g / 1000}s
              </option>
            ))}
          </select>
        </label>

        {phase === "playing" ? (
          <button
            type="button"
            onClick={handlePause}
            disabled={disabled}
            title="暂停"
            aria-label="暂停"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--fg)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ⏸
          </button>
        ) : (
          <button
            type="button"
            onClick={phase === "paused" ? handleResume : handlePlay}
            disabled={disabled}
            title={phase === "paused" ? "继续播放" : "开始播放"}
            aria-label={phase === "paused" ? "继续播放" : "开始播放"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--fg)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ▶
          </button>
        )}

        <button
          type="button"
          onClick={handleRestart}
          disabled={disabled}
          title="从头开始播放"
          aria-label="从头开始播放"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--fg)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ⟲
        </button>
      </div>
    </div>
  );
}
