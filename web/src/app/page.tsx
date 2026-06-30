/**
 * Home page — the landing surface for GET!.
 *
 * The search entry now lives in the global sticky header (see RootLayout),
 * so this page is just calendar + today's punch-in card. We keep a friendly
 * heading at the top so the user knows which surface they're on, but the
 * actual search input is one tap away in the header from anywhere in the app.
 */
import CheckinSection from "@/components/CheckinSection";
import WordbookSection from "@/components/WordbookSection";

export default function HomePage() {
  return (
    <div className="flex flex-col md:flex-row gap-6 min-h-0" style={{ height: 'calc(100vh - 120px)' }}>
      {/* 打卡区 */}
      <section className="flex-1 min-w-0 flex flex-col h-full">
        <CheckinSection />
      </section>

      {/* 单词本区 */}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col h-full">
        <WordbookSection />
      </section>
    </div>
  );
}
