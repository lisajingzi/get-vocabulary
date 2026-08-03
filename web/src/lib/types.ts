/**
 * Shared types used across the GET! frontend & API layer.
 *
 * Keep this file framework-agnostic — it should not import from `next` or
 * `@supabase/*` so the types can be reused on both client and server.
 */

/** A single example sentence inside a sense. */
export interface DictExample {
  /** English sentence as published in the Oxford 9 mdx. */
  en: string;
  /** Chinese translation. May be missing for a small number of entries. */
  cn?: string;
}

/** One sense (定义条目) inside a dictionary entry. */
export interface DictSense {
  /** Part of speech, e.g. "verb" / "noun" / "adjective". May be empty. */
  pos: string;
  /** English definition. */
  def?: string;
  /** Chinese gloss extracted from <chn> at the tail of <def>. */
  chn?: string;
  /** 0..6 example sentences (the parser caps this). */
  ex?: DictExample[];
  /**
   * Illustration attached to this sense in the Oxford 9 mdx.
   * `thumb` is a ~300px thumbnail; `big` is the full-size composition
   * image (often labelled with multiple related nouns). Both are optional;
   * senses without an illustration have `img` omitted entirely.
   *
   * The values are bare filenames (e.g. `"thumb_ant.jpg"`); resolve them
   * against `NEXT_PUBLIC_COS_IMAGE_BASE` to get a fetchable URL.
   */
  img?: { thumb?: string; big?: string };
}

/**
 * One collocation / grammatical frame ("common phrase") attached to an
 * entry. Extracted from <cf-blk><cf>~ to sth</cf></cf-blk> in the Oxford 9
 * mdx by `scripts/parse_mdx.py`.
 *
 *   pattern:  original Oxford form, with `~` standing in for the lemma
 *             ("~ to sth", "~ (with sb) (about/on sth)").
 *   filled:   same but with `~` substituted by the lemma, so the UI can
 *             render "prone to sth" directly without more processing.
 *   example:  the nearest example sentence attached to this frame in the
 *             mdx, if any (a lot of frames come with one, some don't).
 */
export interface DictPhrase {
  pattern: string;
  filled: string;
  example?: DictExample;
}

/**
 * Full structured entry, as written by `scripts/parse_mdx.py` into the
 * per-shard `dictionary-{a..z}.json` files.
 *
 * Two shapes coexist in those files:
 *   - Canonical entries  →  { lemma, senses, phon? }
 *   - Cross-ref aliases  →  { lemma, alias_of }
 *
 * The dictionary access layer (lib/dict/index.ts) follows aliases
 * automatically and only ever returns canonical entries to the UI.
 */
export interface DictEntry {
  lemma: string;
  senses: DictSense[];
  phon?: { uk?: string; us?: string };
  /** Common collocation frames; omitted for entries that have none. */
  phrases?: DictPhrase[];
}

export interface DictAlias {
  lemma: string;
  alias_of: string;
}

export type DictRecord = DictEntry | DictAlias;

export function isAlias(rec: DictRecord): rec is DictAlias {
  return (rec as DictAlias).alias_of !== undefined;
}

/** Per-user wordbook record persisted to Supabase. */
export interface UserWord {
  id: string;
  user_id: string;
  lemma: string;
  status: "new" | "old";
  query_count: number;
  /** 0..7 — Ebbinghaus level. 7 == graduated to "old friend". */
  level: number;
  next_review_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}
