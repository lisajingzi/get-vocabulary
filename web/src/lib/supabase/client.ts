/**
 * Browser-side Supabase client.
 *
 * Use this from React components and client-side hooks. It reads only the
 * public env vars (`NEXT_PUBLIC_*`) and stores its session in cookies via
 * `@supabase/ssr` so server actions can also see it.
 *
 * Do NOT use this on the server — call `createServerSupabase()` from
 * `./server.ts` there instead.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy web/.env.example to web/.env.local and fill them in."
    );
  }
  return createBrowserClient(url, anon);
}
