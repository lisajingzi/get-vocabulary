"use client";

/**
 * SyncErrorBanner
 *
 * Fixed red strip at the top of the viewport that appears whenever the
 * cloud sync layer reports a failed auto-push, and disappears as soon as
 * a subsequent push succeeds.
 *
 * Why a dedicated component (not a toast)?
 *   - Sync failures are *sticky* conditions, not transient events. A toast
 *     that fades after 3 s would let the user keep working under the
 *     illusion that everything's fine.
 *   - The banner stays visible until sync actually recovers (either on the
 *     automatic 15 s retry, or when the user clicks "重试 now").
 *
 * Events consumed:
 *   - "get:sync-error" (CustomEvent with detail.failed[]): shown
 *   - "get:sync-ok":                                         cleared
 */

import { useEffect, useState } from "react";
import { schedulePush, resetPushBudget } from "@/lib/sync/cloud";

interface SyncErrorDetail {
  failed: { shard: string; error: string }[];
  at: string;
  /** True once auto-retry has given up; only a manual retry will resume. */
  exhausted?: boolean;
}

export default function SyncErrorBanner() {
  const [detail, setDetail] = useState<SyncErrorDetail | null>(null);

  useEffect(() => {
    const onError = (e: Event) => {
      const ce = e as CustomEvent<SyncErrorDetail>;
      if (ce.detail) setDetail(ce.detail);
    };
    const onOk = () => setDetail(null);
    window.addEventListener("get:sync-error", onError);
    window.addEventListener("get:sync-ok", onOk);
    return () => {
      window.removeEventListener("get:sync-error", onError);
      window.removeEventListener("get:sync-ok", onOk);
    };
  }, []);

  if (!detail) return null;

  const shards = detail.failed.map((f) => f.shard).join("、");

  // Once the retry budget is spent, auto-push is disabled for the rest of
  // the session, so promising an automatic retry would be a lie. The
  // manual button clears the breaker before scheduling.
  const handleRetry = () => {
    resetPushBudget();
    schedulePush(0);
  };

  return (
    <div className="sticky top-0 z-40 border-b border-red-300 bg-red-50 text-red-800">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-2 text-sm">
        <span aria-hidden>⚠️</span>
        <span className="min-w-0 flex-1 truncate">
          {detail.exhausted
            ? `云同步多次失败（${shards}），已暂停自动重试，请手动重试。`
            : `云同步失败（${shards}），本地改动尚未上传。将在 15 秒后自动重试。`}
        </span>
        <button
          type="button"
          onClick={handleRetry}
          className="shrink-0 rounded border border-red-400 bg-white px-2 py-0.5 text-xs font-medium hover:bg-red-100"
        >
          立即重试
        </button>
      </div>
    </div>
  );
}
