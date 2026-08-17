import type { Metadata, Viewport } from "next";
import Link from "next/link";
import SearchBox from "@/components/SearchBox";
import ToastHost from "@/components/Toast";
import SyncProvider from "@/components/SyncProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "GET!",
  description: "记录、查询并复习你的英语生词。",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon-192.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon-192.svg" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

/**
 * Root layout shared across the entire app.
 *
 * Provides:
 *  - Top navigation between the four core surfaces (home / wordbook /
 *    review / login).
 *  - The page container that gives every screen the Notion-style centered
 *    column with comfortable side padding.
 *
 * The detail page is reached from search results, not the nav, so it isn't
 * exposed here.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-30 border-b border-white/50 bg-white/55 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5),0_8px_24px_rgba(67,101,118,0.10)] supports-[backdrop-filter]:bg-white/40">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3">
            <Link
              href="/"
              className="shrink-0 text-lg font-semibold tracking-tight"
            >
              GET<span className="text-[var(--accent)]">!</span>
            </Link>
            {/* Global sticky search — the core action of this app, available
                from every page so the user never has to scroll back to the
                home hero just to look up a new word. */}
            <div className="min-w-0 flex-1">
              <SearchBox size="sm" />
            </div>
            <nav className="shrink-0 text-sm">
              <Link
                href="/wordbook"
                className="text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
              >
                单词本
              </Link>
              <Link
                href="/notebook"
                className="ml-4 text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
              >
              笔记本
              </Link>
              <Link
                href="/wrongbook"
                className="ml-4 text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
              >
                错词本
              </Link>
              <Link
                href="/settings"
                className="ml-4 text-[var(--fg-soft)] transition hover:text-[var(--fg)]"
              >
                设置
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-6">{children}</main>
        <ToastHost />
        <SyncProvider />
        {/*
          We intentionally do NOT register a Service Worker anymore.

          A previous version of this layout registered /sw.js on load, and
          that SW served the HTML shell stale-while-revalidate. On Vercel
          this caused hard-to-reproduce white screens after every deploy:
          the SW would keep handing users an old HTML document whose
          referenced JS chunk hashes had already been replaced on the CDN,
          so the browser would try to load chunks that returned 404 and
          the app would fail to boot — particularly stubborn inside the
          WeChat WebView and iOS Safari, where users can't easily clear
          site data.

          /public/sw.js is now a self-destructing SW: any client that
          still has the old registration will fetch it on next visit,
          run its `activate` handler, wipe all caches and unregister
          itself, and reload — restoring the app to a plain HTTP-cache
          setup that Vercel already tunes correctly (immutable +
          content-hashed /_next/static/*, ETag'd HTML).

          Do not re-add SW registration here without a rock-solid
          network-first HTML strategy that guarantees old shells can
          never outlive their chunk hashes.
        */}
      </body>
    </html>
  );
}
