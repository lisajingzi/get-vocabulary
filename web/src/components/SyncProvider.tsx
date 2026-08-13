"use client";

/**
 * SyncProvider
 *
 * Mounts once at the root and wires up automatic cloud sync:
 *   - On mount: pull remote snapshot and merge into local.
 *   - On tab becoming visible again: pull (throttled to once per 5s) so
 *     switching back from another tab / another device picks up new data
 *     without needing a manual refresh.
 *   - On any local data change event: schedule a debounced push.
 *
 * The events listened to are the same CustomEvents dispatched by the
 * local storage write helpers in wordbook/local.ts, notebook/local.ts, etc.
 */

import { useEffect } from "react";
import { pull, schedulePush, flushPush } from "@/lib/sync/cloud";
import { migrateEntries, normalizeIeltsGroups, resetImportedQueryCount } from "@/lib/wordbook/local";
import { migrateCoreExamples } from "@/lib/wordbook/core-example";

const CHANGE_EVENTS = [
  "get:wordbook-change",
  "get:notes-change",
  "get:notebook-change",
  "get:notebook-notes-change",
  "get:punch-change",
  "get:preferences-change",
  // \u65b0\u589e\uff1a\u590d\u4e60\u8ba1\u6570\u53d8\u5316\u4e5f\u9700\u540c\u6b65\u3002
  "get:review-log-change",
  // Fired only when THIS device freezes its own daily review queue
  // (not when the queue is applied from a remote pull — that path uses
  // `applyRemoteSnapshot` which stays silent to avoid a push loop).
  "get:daily-snapshot-local-write",
];

// Events that must be flushed to the cloud immediately (no 3 s debounce),
// because they're low-frequency but high-value and easy to lose if the tab
// closes right after the action (e.g. daily punch-in).
const FLUSH_EVENTS = ["get:punch-flush"];

// Minimum gap between visibility-driven pulls, to avoid hammering the API
// if the user rapidly alt-tabs.
const VISIBILITY_PULL_THROTTLE_MS = 5000;

export default function SyncProvider() {
  useEffect(() => {
    // 先做本地数据迁移：为老词条回填 reviewCount / errorCount / inWrongBook 等
    // 新增字段的默认值，避免后续 UI 处处写 `?? 0` 兜底。coreExample 迁移需要
    // 字典参与，异步在后台逐条回填。
    migrateEntries();
    void migrateCoreExamples();

    // 一次性归一化雅思导入组名：去掉数字后缀 & 合并同主题。跑完打个
    // localStorage 标记，避免每次刷新都扫全库。若未来云端拉下来老命名，
    // 用户可以手动清 localStorage.get:group-normalize:v1 再触发。
    const GROUP_MIGRATION_KEY = "get:group-normalize:v2";
    try {
      if (
        typeof window !== "undefined" &&
        !window.localStorage.getItem(GROUP_MIGRATION_KEY)
      ) {
        const changed = normalizeIeltsGroups();
        window.localStorage.setItem(GROUP_MIGRATION_KEY, String(Date.now()));
        if (changed > 0) {
          // 触发一次云同步，把归一化后的组名推上去。
          window.dispatchEvent(new Event("get:wordbook-change"));
        }
      }
    } catch {
      // localStorage 可能不可用，失败时则不阅发迁移。
    }

    // 一次性回填：老版本（及任何走 recordLookup 通道的）批量导入会误把
    // queryCount 设为 1，使这些词看起来"已查过一次"。修完代码后给存量数据
    // 重置。判据 `!lastQueriedAt` 保证真被查过一次的词不会被误伤。
    // v2：把回填范围从「仅雅思词」放宽到「所有 queryCount===1 && !lastQueriedAt
    // 的词」，覆盖早期普通导入同样误触的情况（与 cloud.ts 的 effectiveQueryCount
    // 判据对齐）。版本号 bump 让已跑过 v1 的老用户也会重新执行一次。
    const IMPORT_COUNT_FIX_KEY = "get:ielts-import-count-fix:v2";
    try {
      if (
        typeof window !== "undefined" &&
        !window.localStorage.getItem(IMPORT_COUNT_FIX_KEY)
      ) {
        const changed = resetImportedQueryCount();
        window.localStorage.setItem(IMPORT_COUNT_FIX_KEY, String(Date.now()));
        if (changed > 0) {
          window.dispatchEvent(new Event("get:wordbook-change"));
        }
      }
    } catch {
      // localStorage 不可用，跳过。
    }

    let lastPullAt = 0;
    const doPull = () => {
      lastPullAt = Date.now();
      pull().catch(() => {});
    };

    // Pull on mount (quietly — errors are swallowed)
    doPull();

    // Pull whenever the tab becomes visible again (throttled).
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastPullAt < VISIBILITY_PULL_THROTTLE_MS) return;
      doPull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const handler = () => schedulePush();
    for (const ev of CHANGE_EVENTS) {
      window.addEventListener(ev, handler);
    }
    const flushHandler = () => flushPush();
    for (const ev of FLUSH_EVENTS) {
      window.addEventListener(ev, flushHandler);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const ev of CHANGE_EVENTS) {
        window.removeEventListener(ev, handler);
      }
      for (const ev of FLUSH_EVENTS) {
        window.removeEventListener(ev, flushHandler);
      }
    };
  }, []);

  return null; // renders nothing
}
