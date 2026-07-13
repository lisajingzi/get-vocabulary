"use client";

/**
 * SyncProvider
 *
 * Mounts once at the root and wires up automatic cloud sync:
 *   - On mount: pull remote snapshot and merge into local.
 *   - On any local data change event: schedule a debounced push.
 *
 * The events listened to are the same CustomEvents dispatched by the
 * local storage write helpers in wordbook/local.ts, notebook/local.ts, etc.
 */

import { useEffect } from "react";
import { pull, schedulePush } from "@/lib/sync/cloud";

const CHANGE_EVENTS = [
  "get:wordbook-change",
  "get:notes-change",
  "get:notebook-change",
  "get:notebook-notes-change",
  "get:punch-change",
];

export default function SyncProvider() {
  useEffect(() => {
    // Pull on mount (quietly — errors are swallowed)
    pull().catch(() => {});

    const handler = () => schedulePush();
    for (const ev of CHANGE_EVENTS) {
      window.addEventListener(ev, handler);
    }
    return () => {
      for (const ev of CHANGE_EVENTS) {
        window.removeEventListener(ev, handler);
      }
    };
  }, []);

  return null; // renders nothing
}
