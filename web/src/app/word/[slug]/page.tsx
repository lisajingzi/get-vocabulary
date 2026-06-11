/**
 * /word/[slug] — word detail page (server boundary).
 *
 * The actual UI is in <WordDetailView />. Keeping the route file thin lets
 * the view stay a client component while this stays a server component, which
 * is important for `params` to behave as Next expects.
 *
 * `?from=wordbook` (or any other non-search origin) tells the view NOT to
 * count this visit as a fresh lookup — only navigation from the top search
 * box should bump query stats. Any other value (or absence) = treat as a
 * real query.
 */
import WordDetailView from "@/components/WordDetailView";

export default function WordDetailPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { from?: string };
}) {
  return (
    <WordDetailView
      slug={decodeURIComponent(params.slug)}
      from={searchParams?.from}
    />
  );
}
