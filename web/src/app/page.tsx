/**
 * Home page — the landing surface for GET!.
 *
 * Layout per product spec:
 *   1. A large search entry ("查词入口") — live, with type-ahead suggestions.
 *   2. A monthly calendar card showing punch-in history ("打卡日历").
 *   3. A "today's punch-in" card showing review progress for the day.
 *
 * Calendar + today card are both client components because they read from
 * localStorage; the page itself stays a thin server shell.
 */
import HomeReviewCard from "@/components/HomeReviewCard";
import PunchCalendar from "@/components/PunchCalendar";
import SearchBox from "@/components/SearchBox";

export default function HomePage() {
  return (
    <div className="space-y-5">
      {/* 1. 查词入口 */}
      <section className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          今天遇到了哪个生词？
        </h1>
        <SearchBox autoFocus />
      </section>

      {/* 2 & 3. 打卡日历  +  今日打卡  ——  桌面左右分栏 */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-[1.6fr_1fr]">
        <PunchCalendar />
        <HomeReviewCard />
      </section>
    </div>
  );
}
