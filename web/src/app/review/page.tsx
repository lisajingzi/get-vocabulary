/**
 * /review — Ebbinghaus daily review (Day 6, server boundary).
 *
 * Thin route file; the actual flow lives in <ReviewView /> client component.
 * Kept thin so the page itself can stay statically rendered and start fast,
 * while the queue + quiz state lives in the client where IndexedDB lives.
 *
 * ReviewView reads `?group=active|passive|all` via `useSearchParams`, so it
 * must sit inside a <Suspense /> boundary — otherwise Next opts the whole
 * route out of static generation and warns at build time.
 */
import { Suspense } from "react";
import ReviewView from "@/components/ReviewView";

export default function ReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewView />
    </Suspense>
  );
}
