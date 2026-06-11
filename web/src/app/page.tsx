/**
 * Home page — the landing surface for GET!.
 *
 * The search entry now lives in the global sticky header (see RootLayout),
 * so this page is just calendar + today's punch-in card. We keep a friendly
 * heading at the top so the user knows which surface they're on, but the
 * actual search input is one tap away in the header from anywhere in the app.
 */
import HomeReviewCard from "@/components/HomeReviewCard";
import PunchCalendar from "@/components/PunchCalendar";

export default function HomePage() {
  return (
    <div className="space-y-5">
      {/* 打卡日历  +  今日打卡  ——  桌面左右分栏 */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-[1.6fr_1fr]">
        <PunchCalendar />
        <HomeReviewCard />
      </section>
    </div>
  );
}
