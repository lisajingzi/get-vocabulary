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

const CHANGE_EVENTS = [
  "get:wordbook-change",
  "get:notes-change",
  "get:notebook-change",
  "get:notebook-notes-change",
  "get:punch-change",
  "get:preferences-change",
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
