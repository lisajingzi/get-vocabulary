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
  /** Lowercased lemma for matching; only set for word tokens. */
  match?: string;
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
    // Pick the shortest candidate as the canonical lemma — that's how
    // wink-lemmatizer's chains tend to converge ("abandoned" → "abandon").
    const cands = lemmaCandidates(word, lem);
    const match = cands.reduce(
      (best, c) => (c.length < best.length ? c : best),
      cands[0],
    );
    out.push({ kind: "word", raw: word, match });
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
        const isTarget = t.match && t.match === target;
        const isKnown = !isTarget && t.match && knownSet.has(t.match);
        if (!isTarget && !isKnown) {
          return <Fragment key={i}>{t.raw}</Fragment>;
        }
        // Target = the word being learned: strong accent + bold, NOT a link
        // (clicking your way back to yourself is pointless and confuses the
        // back stack).
        if (isTarget) {
          return (
            <span
              key={i}
              className="font-semibold text-[var(--accent)]"
            >
              {t.raw}
            </span>
          );
        }
        // Known = previously-looked-up word: lighter shade of the accent so
        // it stands out from black body text but doesn't compete with the
        // target word. Clickable, no underline (color carries enough signal).
        return (
          <Link
            key={i}
            href={`/word/${encodeURIComponent(t.match!)}`}
            className="text-[var(--accent)]/60 transition hover:text-[var(--accent)]"
          >
            {t.raw}
          </Link>
        );
      })}
    </span>
  );
}
