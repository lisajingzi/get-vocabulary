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
import { migrateEntries } from "@/lib/wordbook/local";
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
    // \u5148\u505a\u672c\u5730\u6570\u636e\u8fc1\u79fb\uff1a\u65b0\u589e\u5b57\u6bb5\uff08reviewCount/errorCount/inWrongBook\uff09\u56de\u586b\n    // \u9ed8\u8ba4\u503c\uff0c\u540e\u7eed UI \u5c31\u4e0d\u9700\u8981\u5904\u5904\u5199 `?? 0` \u515c\u5e95\u3002coreExample \u8fc1\u79fb\u9700\u8981\n    // \u5b57\u5178\u53c2\u4e0e\uff0c\u5f02\u6b65\u542f\u52a8\u540e\u540e\u53f0\u9010\u6761\u56de\u586b\u3002\n    migrateEntries();\n    void migrateCoreExamples();\n\n    let lastPullAt = 0;
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
