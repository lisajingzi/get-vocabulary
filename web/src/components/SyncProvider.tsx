"use client";

/**
 * SyncProvider
 *
 * Mounts once at the root and wires up automatic cloud sync:
 *   - On mount: pull remote snapshot and merge into local.
 *   - On tab becoming visible again: pull (throttled to once per 5s) so
 *     switching back from another tab / device picks up new data without
 *     needing a manual refresh.
 *   - On any local data change event: mark the corresponding shard dirty
 *     and schedule a debounced push.
 */

import { useEffect } from "react";
import {
  pull,
  schedulePush,
  flushPush,
  markDirty,
  EVENT_TO_SHARD,
  type ShardName,
} from "@/lib/sync/cloud";
import {
  migrateEntries,
  normalizeIeltsGroups,
  resetImportedQueryCount,
  hydrateNotesFromIdb,
} from "@/lib/wordbook/local";
import { hydrateNotebookNotesFromIdb } from "@/lib/notebook/local";
import { migrateCoreExamples } from "@/lib/wordbook/core-example";

// Events that must be flushed to the cloud immediately (no 3 s debounce),
// because they're low-frequency but high-value and easy to lose if the tab
// closes right after the action (e.g. daily punch-in).
const FLUSH_EVENTS: Record<string, ShardName> = {
  "get:punch-flush": "punches",
};

// Minimum gap between visibility-driven pulls, to avoid hammering the API
// if the user rapidly alt-tabs.
const VISIBILITY_PULL_THROTTLE_MS = 5000;

export default function SyncProvider() {
  useEffect(() => {
    // Local migrations: backfill new fields on old entries, resolve default
    // core examples asynchronously, etc. See wordbook/local.ts for details.
    migrateEntries();
    void migrateCoreExamples();

    // One-off IELTS group-name normalization (dedup numeric suffixes, merge
    // by topic). Guarded by a localStorage flag so we don't re-run every
    // page load. If the cloud ships an old-format snapshot the user can
    // clear that flag manually to force a rerun.
    const GROUP_MIGRATION_KEY = "get:group-normalize:v2";
    try {
      if (
        typeof window !== "undefined" &&
        !window.localStorage.getItem(GROUP_MIGRATION_KEY)
      ) {
        const changed = normalizeIeltsGroups();
        try {
          window.localStorage.setItem(
            GROUP_MIGRATION_KEY,
            String(Date.now()),
          );
        } catch {
          /* quota: harmless, we just re-run next mount */
        }
        if (changed > 0) {
          markDirty("wordbook");
          window.dispatchEvent(new Event("get:wordbook-change"));
        }
      }
    } catch {
      /* localStorage unavailable — skip migration */
    }

    // One-off: reset spurious queryCount=1 that old batch-import code left
    // behind. See resetImportedQueryCount() for details.
    const IMPORT_COUNT_FIX_KEY = "get:ielts-import-count-fix:v2";
    try {
      if (
        typeof window !== "undefined" &&
        !window.localStorage.getItem(IMPORT_COUNT_FIX_KEY)
      ) {
        const changed = resetImportedQueryCount();
        try {
          window.localStorage.setItem(
            IMPORT_COUNT_FIX_KEY,
            String(Date.now()),
          );
        } catch {
          /* ignore */
        }
        if (changed > 0) {
          markDirty("wordbook");
          window.dispatchEvent(new Event("get:wordbook-change"));
        }
      }
    } catch {
      /* ignore */
    }

    let lastPullAt = 0;
    // hydrateNotesFromIdb / hydrateNotebookNotesFromIdb are idempotent
    // and return the same promise on repeat calls, so awaiting them from
    // doPull() is cheap after the first mount (a resolved promise). This
    // covers the case where visibility flips before the initial hydrate
    // finished.
    const doPull = async () => {
      try {
        await Promise.all([
          hydrateNotesFromIdb(),
          hydrateNotebookNotesFromIdb(),
        ]);
      } catch {
        /* hydrators log their own errors */
      }
      lastPullAt = Date.now();
      pull().catch(() => {});
    };

    // Kick off the initial hydrate + pull sequence. useEffect can't be
    // async itself, hence the void wrapper.
    void doPull();

    // Pull whenever the tab becomes visible again (throttled).
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastPullAt < VISIBILITY_PULL_THROTTLE_MS) return;
      void doPull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // For every change event, flag the corresponding shard dirty and
    // schedule a debounced push. Only that shard will be uploaded.
    const changeHandler = (ev: Event) => {
      const shard = EVENT_TO_SHARD[ev.type];
      if (shard) markDirty(shard);
      schedulePush();
    };
    const changeEvents = Object.keys(EVENT_TO_SHARD);
    for (const ev of changeEvents) {
      window.addEventListener(ev, changeHandler);
    }

    // Flush events push immediately (no debounce). Also flag the shard
    // dirty first so the flush actually has something to send.
    const flushHandler = (ev: Event) => {
      const shard = FLUSH_EVENTS[ev.type];
      if (shard) markDirty(shard);
      flushPush();
    };
    const flushEventNames = Object.keys(FLUSH_EVENTS);
    for (const ev of flushEventNames) {
      window.addEventListener(ev, flushHandler);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      for (const ev of changeEvents) {
        window.removeEventListener(ev, changeHandler);
      }
      for (const ev of flushEventNames) {
        window.removeEventListener(ev, flushHandler);
      }
    };
  }, []);

  return null;
}
