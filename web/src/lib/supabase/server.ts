/**
 * Server-side Supabase client (for App Router server components, route
 * handlers and server actions).
 *
 * - `createServerSupabase()` reads/writes the auth cookie via Next's
 *   `cookies()` helper so the user's session flows from the browser to RSC.
 * - `createServiceSupabase()` returns a privileged client using the service
 *   role key. Only use this from API routes for things RLS forbids.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "Missing Supabase env. Copy web/.env.example to web/.env.local."
    );
  }
  const cookieStore = cookies();
  return createServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // `set` may be called from a Server Component, where mutating
          // cookies is forbidden. Middleware refreshes them, so ignoring
          // this is safe here.
        }
      },
      remove(name: string, options) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // See note above.
        }
      },
    },
  });
}

/**
 * Privileged client used by API routes for operations that need to bypass
 * Row Level Security (e.g. seeding, admin tasks). Never expose the resulting
 * client or queries to the browser.
 */
export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env.");
  }
  return createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
