"use client";

/**
 * /notebook/phrase/[slug] — phrase detail page.
 *
 * Two entry paths:
 *   1. From /notebook list          → the entry already exists locally.
 *      We just render its cached AI payload (if any) or manual notes.
 *   2. From the top search bar      → URL carries `?ai=1&text=<original>`.
 *      If the entry doesn't exist yet OR exists without AI content, we
 *      fire /api/ai/phrase ONCE, cache the result on the entry, and never
 *      re-fire for the same slug.
 *
 * Layout:
 *   - Header: phrase text + speak button, subtle back-link to /notebook
 *   - Right rail (top-right): tabs 「记笔记 / 不收藏」
 *       * 记笔记 (default) → keep entry in the notebook, show notes composer
 *       * 不收藏           → drop the entry (deleteEntry) and navigate back
 *                            to /notebook. This mirrors the wordbook's
 *                            archive semantics simply and unambiguously.
 *   - Body:
 *       * AI card (chn / def / posHint / examples / collocations / synonyms / notes)
 *         — only rendered when entry.source === "ai" and entry.ai is set.
 *       * NotebookNotesPanel — always visible in "记笔记" mode.
 */

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import NotebookNotesPanel from "@/components/NotebookNotesPanel";
import SpeakButton from "@/components/SpeakButton";
import { toast } from "@/components/Toast";
import {
  deleteEntry,
  getPhraseBySlug,
  type NotebookEntry,
  type PhraseAIResult,
  upsertPhrase,
} from "@/lib/notebook/local";

function PhraseDetailInner() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const slug = decodeURIComponent(params?.slug ?? "");

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  // "记笔记" is the default tab as speced. "不收藏" is a one-shot destructive
  // action that returns the user to the notebook list — no need for the tab
  // to be a persisted piece of state.
  const [tab, setTab] = useState<"note" | "archive">("note");
  // Guard so an accidental double-render (Strict Mode, HMR) doesn't fire the
  // AI generation twice.
  const generationStartedRef = useRef(false);

  const wantAi = search.get("ai") === "1";
  const originalText = search.get("text");

  // ---- entry hydration --------------------------------------------------

  const refresh = useCallback(() => {
    setEntry(getPhraseBySlug(slug));
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    refresh();
    function onChange() {
      refresh();
    }
    window.addEventListener("get:notebook-change", onChange);
    return () => window.removeEventListener("get:notebook-change", onChange);
  }, [refresh]);

  // ---- AI generation on first visit -------------------------------------

  useEffect(() => {
    if (loading) return;
    if (generationStartedRef.current) return;
    // We fire the AI call exactly when:
    //   - the URL says ?ai=1 (came from the search bar), AND
    //   - either the entry doesn't exist yet, or exists but has no cached AI.
    // Manual entries (source === "manual") are NEVER auto-populated with AI —
    // the user picked the manual path deliberately.
    if (!wantAi) return;
    if (entry && entry.source === "manual") return;
    if (entry && entry.ai) return;

    const phrase =
      (originalText && originalText.trim()) || entry?.text || slug.replace(/-/g, " ");
    if (!phrase) return;

    generationStartedRef.current = true;
    setAiBusy(true);
    setAiErr(null);
    (async () => {
      try {
        const res = await fetch("/api/ai/phrase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phrase }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Omit<PhraseAIResult, "generatedAt">;
        const ai: PhraseAIResult = {
          ...data,
          generatedAt: new Date().toISOString(),
        };
        upsertPhrase({ text: phrase, source: "ai", ai });
      } catch (err) {
        console.warn("[notebook/phrase] AI generation failed:", err);
        setAiErr((err as Error).message);
        // Roll the guard back so a manual retry (future button) can re-fire.
        generationStartedRef.current = false;
        toast("AI 生成失败，可稍后重试");
      } finally {
        setAiBusy(false);
      }
    })();
  }, [loading, wantAi, entry, originalText, slug]);

  // ---- handlers ---------------------------------------------------------

  function handleArchive() {
    if (!entry) {
      // Nothing saved yet (search-bar arrival mid-generation), just go back.
      router.push("/notebook");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定不收藏这个短语？将从笔记本移除，笔记也会一并删除。")
    ) {
      // Snap the tab back to "记笔记" so the user isn't stuck on a
      // destructive-looking view they cancelled.
      setTab("note");
      return;
    }
    deleteEntry(entry.id);
    toast("已从笔记本移除");
    router.push("/notebook");
  }

  // ---- render helpers ---------------------------------------------------

  const displayText =
    entry?.text ||
    originalText ||
    slug.replace(/-/g, " ");

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-[var(--fg-soft)]">
          <Link href="/notebook" className="hover:text-[var(--accent)]">
            ← 返回笔记本
          </Link>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {displayText}
            </h1>
            <SpeakButton text={displayText} variant="us" />
            {entry?.source === "ai" && (
              <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent)]">
                AI
              </span>
            )}
          </div>

          {/* Tabs 记笔记 / 不收藏 */}
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
            {(
              [
                { key: "note", label: "记笔记" },
                { key: "archive", label: "不收藏" },
              ] as const
            ).map((it) => {
              const active = tab === it.key;
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => {
                    if (it.key === "archive") {
                      setTab("archive");
                      handleArchive();
                    } else {
                      setTab("note");
                    }
                  }}
                  className={[
                    "rounded px-3 py-1 text-sm transition",
                    active
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--fg-soft)] hover:text-[var(--fg)]",
                  ].join(" ")}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {aiBusy && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-[var(--bg-soft)]" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--bg-soft)]" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--bg-soft)]" />
          <p className="text-xs text-[var(--fg-soft)]">AI 生成中，请稍候…</p>
        </div>
      )}

      {aiErr && !aiBusy && !entry?.ai && (
        <p className="text-xs text-red-500">
          AI 生成失败：{aiErr}。可以先手动记录，或稍后再来。
        </p>
      )}

      {entry?.ai && <PhraseAICard ai={entry.ai} />}

      {!entry && !aiBusy && !wantAi && (
        <p className="text-sm text-[var(--fg-soft)]">
          未找到这个短语的记录，返回笔记本重新添加。
        </p>
      )}

      {/* Notes region — always available, even before AI arrives so the
          user can jot down a first thought right away. Requires an entry. */}
      {entry ? (
        <NotebookNotesPanel
          entryId={entry.id}
          placeholder={`关于 "${displayText}" 的笔记…`}
        />
      ) : wantAi ? (
        <p className="text-xs text-[var(--fg-soft)]">
          AI 生成完成后，这里会出现笔记输入框。
        </p>
      ) : null}
    </div>
  );
}

/** Presentation-only card for the AI payload. */
function PhraseAICard({ ai }: { ai: PhraseAIResult }) {
  return (
    <section className="space-y-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)]/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {ai.posHint && (
          <span className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--fg-soft)]">
            {ai.posHint}
          </span>
        )}
        {ai.provider === "mock" && (
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-soft)]">
            模拟数据
          </span>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-lg font-medium">{ai.chn}</p>
        <p className="text-sm text-[var(--fg-soft)]">{ai.def}</p>
      </div>

      {ai.examples.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
            例句
          </h3>
          <ul className="space-y-2 border-l border-[var(--border)] pl-3">
            {ai.examples.map((ex, i) => (
              <li key={i} className="space-y-0.5">
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm">{ex.en}</p>
                  <SpeakButton text={ex.en} variant="us" />
                </div>
                {ex.cn && (
                  <p className="text-xs text-[var(--fg-soft)]">{ex.cn}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {ai.collocations && ai.collocations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
            常见搭配
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {ai.collocations.map((c) => (
              <span
                key={c}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-xs text-[var(--fg)]"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {ai.synonyms && ai.synonyms.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
            近义表达
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {ai.synonyms.map((s) => (
              <span
                key={s}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-xs text-[var(--fg)]"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {ai.notes && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
            使用提示
          </h3>
          <p className="text-xs leading-relaxed text-[var(--fg-soft)]">
            {ai.notes}
          </p>
        </div>
      )}
    </section>
  );
}

export default function PhraseDetailPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--fg-soft)]">加载中…</p>
      }
    >
      <PhraseDetailInner />
    </Suspense>
  );
}
