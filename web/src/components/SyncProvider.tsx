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
import { hydrateStringNotesFromIdb } from "@/lib/wordbook/string-notes";
import { migrateCoreExamples } from "@/lib/wordbook/core-example";
import {
  migrateInlineImages,
  isImageMigrationDone,
} from "@/lib/wordbook/image-migrate";

// Events that must be flushed to the cloud immediately (no 3 s debounce),
// because they're low-frequency but high-value and easy to lose if the tab
// closes right after the action (e.g. daily punch-in).
const FLUSH_EVENTS: Record<string, ShardName> = {
  "get:punch-flush": "punches",
};

// Minimum gap between visibility-driven pulls.
//
// This used to be 5 seconds, which on mobile meant a full 11-shard pull
// every time the user unlocked the phone or switched back from another
// app. Combined with uncached (no-store) shard responses that was a
// major contributor to blowing through the hosting bandwidth quota.
//
// Five minutes is still responsive enough for cross-device use (the
// realistic gap between editing on a laptop and picking up the phone),
// while cutting incidental pulls by roughly two orders of magnitude.
// Conditional requests make each surviving pull nearly free anyway.
const VISIBILITY_PULL_THROTTLE_MS = 5 * 60 * 1000;

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
          hydrateStringNotesFromIdb(),
        ]);
      } catch {
        /* hydrators log their own errors */
      }
      lastPullAt = Date.now();
      await pull().catch(() => {});
    };

    // Kick off the initial hydrate + pull sequence, then run the one-time
    // legacy-image migration.
    //
    // Ordering matters here. The migration rewrites note stores, so it
    // must run AFTER hydration (otherwise the in-memory caches are empty
    // and writing back would wipe real data) and after the initial pull
    // has merged in whatever the cloud holds (otherwise we'd convert a
    // stale local subset and then have the pull merge the base64
    // originals straight back in).
    //
    // It is deliberately not awaited by anything user-facing: uploads
    // happen in small throttled batches in the background and the UI
    // stays fully usable throughout.
    void (async () => {
      await doPull();
      if (isImageMigrationDone()) return;
      try {
        const report = await migrateInlineImages();
        if (report.converted > 0) {
          // Converted notes are already written locally and their shards
          // marked dirty; nudge the pusher so the slimmed-down payloads
          // reach the cloud.
          schedulePush(1_000);
        }
      } catch (e) {
        console.warn("[sync] inline image migration failed", e);
      }
    })();

    // Pull whenever the tab becomes visible again (throttled). Also flush
    // any pending dirty shards immediately \u2014 if the user left the tab in
    // the middle of a debounce window, coming back is as good a signal as
    // any that it's time to upload.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      flushPush();
      if (Date.now() - lastPullAt < VISIBILITY_PULL_THROTTLE_MS) return;
      void doPull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // When the network comes back after being offline, flush dirty shards
    // right away. Without this, the user has to perform another action
    // (or alt-tab) before anything gets uploaded.
    const onOnline = () => {
      flushPush();
      if (Date.now() - lastPullAt >= VISIBILITY_PULL_THROTTLE_MS) {
        void doPull();
      }
    };
    window.addEventListener("online", onOnline);

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
      window.removeEventListener("online", onOnline);
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
