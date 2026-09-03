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
 * Failure mode: when every Zhipu tier fails we render a red <AIErrorNotice>
 * that lists each tier's translated reason (see /api/ai/phrase and
 * src/lib/ai/zhipu.ts). We do NOT persist a mock payload — the user can
 * still take manual notes below.
 *
 * On success we show a small "🔢 N tokens · model" footnote once, only for
 * this session (not persisted with the AI payload).
 */

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import NotebookNotesPanel from "@/components/NotebookNotesPanel";
import SpeakButton from "@/components/SpeakButton";
import {
  AIErrorNotice,
  AIUsageNote,
  parseAIErrorAttempts,
  type AIAttempt,
} from "@/components/AIStatus";
import { toast } from "@/components/Toast";
import {
  deleteEntry,
  getPhraseBySlug,
  type NotebookEntry,
  type PhraseAIResult,
  upsertPhrase,
} from "@/lib/notebook/local";
import { useHideChinese } from "@/lib/ui/hide-chinese";

interface FreshUsage {
  model: string;
  usage: { input: number; output: number; total: number };
}

function PhraseDetailInner() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const slug = decodeURIComponent(params?.slug ?? "");

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAttempts, setAiAttempts] = useState<AIAttempt[]>([]);
  const [aiFresh, setAiFresh] = useState<FreshUsage | null>(null);
  const [tab, setTab] = useState<"note" | "archive">("note");
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
    if (!wantAi) return;
    if (entry && entry.source === "manual") return;
    if (entry && entry.ai) return;

    const phrase =
      (originalText && originalText.trim()) || entry?.text || slug.replace(/-/g, " ");
    if (!phrase) return;

    generationStartedRef.current = true;
    setAiBusy(true);
    setAiAttempts([]);
    setAiFresh(null);
    (async () => {
      try {
        const res = await fetch("/api/ai/phrase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phrase }),
        });
        if (!res.ok) {
          const parsed = await parseAIErrorAttempts(res);
          setAiAttempts(parsed);
          generationStartedRef.current = false;
          toast("AI 生成失败，可稍后重试");
          return;
        }
        const data = (await res.json()) as PhraseAIResult & {
          model: string;
          usage: { input: number; output: number; total: number };
        };
        const ai: PhraseAIResult = {
          posHint: data.posHint,
          chn: data.chn,
          def: data.def,
          examples: data.examples,
          collocations: data.collocations,
          synonyms: data.synonyms,
          notes: data.notes,
          generatedAt: new Date().toISOString(),
        };
        upsertPhrase({ text: phrase, source: "ai", ai });
        if (data.model && data.usage) {
          setAiFresh({ model: data.model, usage: data.usage });
        }
      } catch (err) {
        console.warn("[notebook/phrase] AI generation failed:", err);
        setAiAttempts([
          {
            model: "network",
            reason: (err as Error).message || "网络请求失败",
          },
        ]);
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
      router.push("/notebook");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定不收藏这个短语？将从笔记本移除，笔记也会一并删除。")
    ) {
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

      {aiAttempts.length > 0 && !aiBusy && !entry?.ai && (
        <AIErrorNotice
          attempts={aiAttempts}
          hint="可先手动记录，或稍后再来重试"
        />
      )}

      {entry?.ai && <PhraseAICard ai={entry.ai} />}

      {aiFresh && (
        <AIUsageNote model={aiFresh.model} usage={aiFresh.usage} />
      )}

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
  const hideChinese = useHideChinese();
  return (
    <section className="space-y-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)]/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {ai.posHint && (
          <span className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--fg-soft)]">
            {ai.posHint}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {!hideChinese && <p className="text-lg font-medium">{ai.chn}</p>}
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
                {ex.cn && !hideChinese && (
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
