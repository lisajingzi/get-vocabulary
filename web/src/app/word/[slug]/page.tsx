/**
 * /word/[slug] — word detail page (server boundary).
 *
 * The actual UI is in <WordDetailView />. Keeping the route file thin lets
 * the view stay a client component while this stays a server component, which
 * is important for `params` to behave as Next expects.
 *
 * Day 3 will graft 新/老朋友 toggle + notes; Day 4 the AI example block.
 */
import WordDetailView from "@/components/WordDetailView";

export default function WordDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  return <WordDetailView slug={decodeURIComponent(params.slug)} />;
}
