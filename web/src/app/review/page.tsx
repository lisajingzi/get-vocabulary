/**
 * /review — Ebbinghaus daily review (Day 6, server boundary).
 *
 * Thin route file; the actual flow lives in <ReviewView /> client component.
 * Kept thin so the page itself can stay statically rendered and start fast,
 * while the queue + quiz state lives in the client where IndexedDB lives.
 */
import ReviewView from "@/components/ReviewView";

export default function ReviewPage() {
  return <ReviewView />;
}
