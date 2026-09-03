/**
 * "Hide Chinese" — a global UI toggle that lets the user blank out every
 * Chinese gloss (sense.chn) and every Chinese example translation (ex.cn)
 * across the whole app. Useful for immersion-style practice where reading
 * the Chinese first would defeat the purpose.
 *
 * Persistence: mirrored to `localStorage` so the setting survives reloads.
 * Cross-component sync: writes dispatch a `get:hide-chinese-change` event
 * on `window`; the `useHideChinese()` hook listens for that plus the
 * built-in `storage` event so multiple tabs stay consistent.
 *
 * Kept intentionally UI-only — this preference is NOT synced to the cloud
 * snapshot. Different devices may have different reading habits and it's
 * cheap enough to re-toggle when needed.
 */

"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "get:hide-chinese:v1";
const EVENT_NAME = "get:hide-chinese-change";

function readRaw(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRaw(next: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (next) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (e) {
    console.error("[ui/hide-chinese] writeRaw failed", e);
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function getHideChinese(): boolean {
  return readRaw();
}

export function setHideChinese(next: boolean): void {
  writeRaw(next);
}

export function toggleHideChinese(): boolean {
  const next = !readRaw();
  writeRaw(next);
  return next;
}

/**
 * React hook returning the current value of the hide-chinese toggle.
 *
 * SSR-safe: always returns `false` on first render so server and client
 * markup match; the real value is picked up in the effect on mount.
 */
export function useHideChinese(): boolean {
  const [hidden, setHidden] = useState<boolean>(false);

  useEffect(() => {
    setHidden(readRaw());
    function onChange() {
      setHidden(readRaw());
    }
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setHidden(readRaw());
    }
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return hidden;
}
