import type { Metadata, Viewport } from "next";
import Link from "next/link";
import Script from "next/script";
import SearchBox from "@/components/SearchBox";
import ToastHost from "@/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "GET! — 英语单词本",
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
        <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/75">
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
            <nav className="shrink-0 text-sm text-[var(--fg-soft)]">
              <Link href="/wordbook" className="hover:text-[var(--fg)]">
                单词本
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-6">{children}</main>
        <ToastHost />
        {/*
          Service-worker registration. We only register in production so dev
          mode HMR isn't disrupted by stale cached chunks. The script is
          tagged afterInteractive so it doesn't block first paint.
        */}
        <Script id="sw-register" strategy="afterInteractive">{`
          if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
            window.addEventListener('load', () => {
              navigator.serviceWorker.register('/sw.js').catch(() => {});
            });
          }
        `}</Script>
      </body>
    </html>
  );
}
