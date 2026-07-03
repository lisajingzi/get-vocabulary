/**
 * DEPRECATED: /api/ai/synonyms
 *
 * The review-quiz used to fall back here when the offline WordNet table
 * had no synonyms for a lemma. That path was removed because AI-generated
 * synonyms for concrete nouns / rare adjectives were unreliable and often
 * taught the user misleading semantic associations. The client now falls
 * back to a spelling question instead (see <ReviewView />'s SpellPanel).
 *
 * The route is kept as a 410 Gone stub so that any stale client build
 * still trying to hit it fails loudly rather than silently timing out.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  return NextResponse.json(
    { error: "gone", message: "The AI synonyms fallback has been removed." },
    { status: 410 },
  );
}
