"use client";

/**
 * <HighlightedSentence /> — render an English sentence with certain words
 * styled as clickable links to /word/[lemma].
 *
 * Behaviour:
 *   - Whole-word match, case-insensitive. The displayed text keeps its original
 *     case so we don't mangle "Apple" vs "apple".
 *   - Plural / past-tense inflections are stripped via a tiny lemmatiser
 *     (wink-lemmatizer) so "abandoned" still highlights against "abandon".
 *   - Punctuation around the word is preserved untouched.
 *   - Two highlight tiers:
 *       targetLemma   → strong accent (the word the example is "for")
 *       knownLemmas   → soft accent (other wordbook entries woven in)
 *
 * Why client-only: we do dynamic-import wink-lemmatizer to keep its 80 KB
 * payload off the initial bundle; only entries with examples need it.
 */

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";

interface Props {
  text: string;
  /** The word this sentence was generated for; gets the strong highlight. */
  targetLemma?: string;
  /** Other lemmas (already in user's wordbook) to soft-highlight. */
  knownLemmas?: string[];
  /** Tailwind class applied to the wrapper. */
  className?: string;
}

type Lemmatizer = {
  noun: (s: string) => string;
  verb: (s: string) => string;
  adjective: (s: string) => string;
};

let lemmatizerPromise: Promise<Lemmatizer | null> | null = null;
function loadLemmatizer(): Promise<Lemmatizer | null> {
  if (!lemmatizerPromise) {
    lemmatizerPromise = import("wink-lemmatizer")
      .then((mod) => (mod.default ?? mod) as Lemmatizer)
      .catch(() => null);
  }
  return lemmatizerPromise;
}

function lemmaCandidates(word: string, lem: Lemmatizer | null): string[] {
  const lc = word.toLowerCase();
  if (!lem) return [lc];
  // Try all three POS reducers; pick whichever shrinks the word.
  const out = new Set<string>([lc]);
  try {
    out.add(lem.noun(lc));
  } catch {
    /* ignore */
  }
  try {
    out.add(lem.verb(lc));
  } catch {
    /* ignore */
  }
  try {
    out.add(lem.adjective(lc));
  } catch {
    /* ignore */
  }
  return Array.from(out);
}

interface Token {
  kind: "text" | "word";
  raw: string;
  /** All candidate lowercase lemmas to try matching against (in priority order:
   *  surface form first, then lemmatised forms). Only set for word tokens. */
  candidates?: string[];
}

function tokenize(text: string, lem: Lemmatizer | null): Token[] {
  // Split on whitespace + punctuation but keep them as separators.
  const re = /([A-Za-z][A-Za-z'-]*)/g;
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push({ kind: "text", raw: text.slice(last, m.index) });
    }
    const word = m[1];
    // Build a priority-ordered candidate list:
    //   1. surface form (lowercased)        — preserves derivations like
    //      "arousal" / "creation" that the lemmatiser would over-reduce
    //      into a different POS root ("arouse" / "create").
    //   2. lemmatiser reductions             — handles inflections like
    //      "abandoned" → "abandon" or "ran" → "run".
    // Matching downstream tries each in order; the first hit wins. This
    // keeps wordbook entries that ARE the derived form ("arousal") from
    // being silently rewritten to a root the user never saved.
    const lc = word.toLowerCase();
    const reduced = lemmaCandidates(word, lem).filter((c) => c !== lc);
    const candidates = [lc, ...reduced];
    out.push({ kind: "word", raw: word, candidates });
    last = m.index + word.length;
  }
  if (last < text.length) out.push({ kind: "text", raw: text.slice(last) });
  return out;
}

export default function HighlightedSentence({
  text,
  targetLemma,
  knownLemmas = [],
  className,
}: Props) {
  const [lem, setLem] = useState<Lemmatizer | null>(null);

  useEffect(() => {
    let alive = true;
    loadLemmatizer().then((l) => {
      if (alive) setLem(l);
    });
    return () => {
      alive = false;
    };
  }, []);

  const target = targetLemma?.toLowerCase();
  const knownSet = useMemo(
    () => new Set(knownLemmas.map((s) => s.toLowerCase())),
    [knownLemmas],
  );

  // Tokenise once we (maybe) have the lemmatizer. Until then we still render
  // the raw text so there's no flash.
  const tokens = useMemo(() => tokenize(text, lem), [text, lem]);

  return (
    <span className={className}>
      {tokens.map((t, i) => {
        if (t.kind === "text") return <Fragment key={i}>{t.raw}</Fragment>;
        // Walk candidates in priority order: prefer matching the surface
        // form, then any lemmatised reduction. First hit wins.
        let matchedAs: "target" | "known" | null = null;
        let matchedLemma: string | null = null;
        for (const c of t.candidates ?? []) {
          if (c === target) {
            matchedAs = "target";
            matchedLemma = c;
            break;
          }
          if (knownSet.has(c)) {
            matchedAs = "known";
            matchedLemma = c;
            break;
          }
        }
        if (!matchedAs) {
          return <Fragment key={i}>{t.raw}</Fragment>;
        }
        // Target = the word being learned: strong accent + bold, NOT a link
        // (clicking your way back to yourself is pointless and confuses the
        // back stack).
        if (matchedAs === "target") {
          return (
            <span
              key={i}
              className="font-semibold text-[var(--accent-warm)]"
            >
              {t.raw}
            </span>
          );
        }
        // Known = previously-looked-up word: no color change (keeps the
        // page from feeling busy when several known words appear in one
        // sentence), only a dotted underline so it's still clearly marked
        // as a clickable cross-reference. Hover firms up the underline.
        return (
          <Link
            key={i}
            href={`/word/${encodeURIComponent(matchedLemma!)}`}
            className="underline decoration-dotted decoration-[var(--fg-soft)] underline-offset-2 transition hover:decoration-solid hover:decoration-[var(--accent)]"
          >
            {t.raw}
          </Link>
        );
      })}
    </span>
  );
}
