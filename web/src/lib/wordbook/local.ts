/**
 * Local-first query / wordbook tracking.
 *
 * V1 strategy: every successful lookup increments a per-lemma counter held in
 * localStorage. On Day 5 this same shape is mirrored to Supabase so multiple
 * devices converge. Keeping the same in-memory shape means the UI doesn't
 * have to change when we add the cloud half.
 *
 * Why not jump straight to Supabase here? — Day 2 wires the search and detail
 * pages BEFORE we open up auth, and we want a "查过 → 进新朋友本" loop that
 * works for the unauthenticated dev session too.
 */

const STORAGE_KEY = "get:wordbook:v1";
const NOTES_KEY = "get:notes:v1";

/**
 * Wordbook membership states:
 *   - "new"      → 新朋友 (default after first lookup)
 *   - "old"      → 老朋友 (graduated, mastered)
 *   - "archived" → 不收藏 (looked up but explicitly excluded from both books)
 *
 * `archived` words still keep their query history (for the "已查过的词" highlight
 * and per-lemma stats), they just don't show up in either wordbook list.
 */
export type WordbookStatus = "new" | "old" | "archived";

/**
 * How the user wants to use this word — drives which review flow it gets.
 *   - "active"  → 听说写：听音辨词 / 拼写 / 造句 + AI 批改（完整流程）。
 *   - "passive" → 阅读：只求认识，看到能想起中文意思即可（recognize 流程）。
 *
 * Missing / undefined on an entry is treated as "active" everywhere, so
 * legacy rows keep working with zero migration. The user can flip a word
 * between the two via the detail-page toggle.
 */
export type WordbookPurpose = "active" | "passive";

export interface WordbookEntry {
  lemma: string;
  status: WordbookStatus;
  /** Review-flow mode. Undefined = legacy row, treated as "active". */
  purpose?: WordbookPurpose;
  /** Total successful lookups (also the input to "按查询次数排序"). */
  queryCount: number;
  /** Ebbinghaus level 0..7. 7 == graduated to "old friend". */
  level: number;
  /** ISO timestamp of first lookup. */
  firstSeenAt: string;
  /** ISO timestamp of most recent lookup or review. */
  lastSeenAt: string;
  /** ISO timestamp of the most recent ACTUAL review attempt (pass/fail in /review).
   *  Distinct from lastSeenAt because lookups, status moves, etc. also bump
   *  lastSeenAt — only this field reflects "the user really sat down and
   *  graded this card today". Used by the daily progress counter so that
   *  shuffling a card between 新朋友 / 老朋友 doesn't fake completion. */
  lastReviewedAt?: string;
  /** ISO timestamp of the most recent SEARCH-BAR lookup specifically.
   *  Distinct from lastSeenAt because clicking a word from the wordbook
   *  list (which mounts the detail page too) must NOT count as a fresh
   *  query — only entries originated from the top search box do. */
  lastQueriedAt?: string;
  /** ISO timestamp of when the entry next becomes due for review.
   *  Null = graduated; missing on legacy entries (treated as immediately due). */
  nextReviewAt?: string | null;
  /** Snapshot of the first sense's part-of-speech, captured at first lookup.
   *  Lets the wordbook page filter by pos without re-fetching dict shards. */
  pos?: string;
  /** IELTS study flag — orthogonal to purpose (a word can be both 听说写 and 雅思).
   *  true = 已标记雅思；undefined/false = 未标记。用来在单词本、详情页和批量导入里
   *  区分“雅思专用”词。 */
  ielts?: boolean;
  /** 核心例句 / 短语。词条创建时自动从字典抽取默认值（词义区例句优先），
   *  用户可在详情页手动覆盖，回退到空字符串则不再有值。
   *  与 ielts 无关：所有词条统一展示。 */
  coreExample?: string;
  /** 上一次用户手动编辑 coreExample 的时间。字段存在 = 已被人工编辑过，
   *  自动迁移逻辑（refillCoreExampleIfDefault）遇到此字段会跳过，避免
   *  把用户改过的默认值再冲掉。 */
  coreExampleEditedAt?: string;
  /** 雅思分组名（导入时用户填写）。空/未定义 = 未分组。多个词可共享同一组名，
   *  同一词多次导入以最后一次为准。 */
  group?: string;
  /** 累计复习次数（对/错都 +1）。用作筛选与排序依据。 */
  reviewCount?: number;
  /** 累计错误次数（历史错误的总次数，只增不减）。
   *  用于筛选/排序；即使一个词从错词本移除，errorCount 仍保留原值。 */
  errorCount?: number;
  /** 当前是否在错词本内。首次错误 → true；错词本重温复习正确 → false。
   *  与 errorCount 分离：errorCount 是历史，inWrongBook 是当前状态。 */
  inWrongBook?: boolean;
}

/**
 * One note attached to one lemma.
 * `image` is a data URL (base64). We store images inline so the local-only
 * dev experience stays self-contained; the cloud sync layer (Day 3b) will
 * upload base64 → Supabase Storage and replace this with a stable path.
 */
export interface WordNote {
  id: string;
  lemma: string;
  body: string;
  /** Optional image as a data URL ("data:image/png;base64,…"). */
  image?: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, WordbookEntry>;
type NotesStore = Record<string, WordNote[]>; // lemma → notes

// ---------------------------------------------------------------------------
// shared low-level helpers
// ---------------------------------------------------------------------------

export function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

export function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  // Notify same-tab listeners; the native `storage` event only fires across tabs.
  window.dispatchEvent(new CustomEvent("get:wordbook-change"));
}

export function readNotes(): NotesStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as NotesStore;
  } catch {
    return {};
  }
}

export function writeNotes(notes: NotesStore): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  window.dispatchEvent(new CustomEvent("get:notes-change"));
}

// ---------------------------------------------------------------------------
// wordbook entry CRUD
// ---------------------------------------------------------------------------

/**
 * Record a lookup of `lemma`.
 *
 * - Creates the entry if it didn't exist. Default status is "new" (新朋友)
 *   for fresh search-bar lookups, but `opts.skipCount` (used when the user
 *   navigated in from inside the wordbook list) leaves the entry untouched
 *   if it already existed and avoids creating one if it didn't — viewing
 *   isn't "querying".
 * - When NOT skipping, bumps `queryCount`, refreshes `lastSeenAt` AND
 *   `lastQueriedAt`. Both timestamps are needed: lastSeenAt also moves on
 *   reviews, but the wordbook page wants the latest *query* date specifically.
 *
 * `pos` is an optional snapshot of the first sense's part of speech at the
 * time of the lookup; we stamp it on the entry once so the wordbook page can
 * filter by pos cheaply.
 */
export function recordLookup(
  lemma: string,
  pos?: string,
  opts?: { skipCount?: boolean },
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store[key];

  // skipCount == true means "the user opened the detail page from inside the
  // wordbook, not from the search bar". We must NOT create or count.
  if (opts?.skipCount) {
    return existing ?? null;
  }

  const next: WordbookEntry = existing
    ? {
        ...existing,
        queryCount: existing.queryCount + 1,
        lastSeenAt: now,
        lastQueriedAt: now,
        // pos resolution: an explicit pos argument always wins (the caller
        // KNOWS the right tag — e.g. the user just picked it from the chip
        // picker, or we just resolved it from the dictionary's first sense).
        // Only fall back to the stored pos when no new tag was supplied.
        // Using truthiness (not ??) so empty-string pos legacy rows get
        // overwritten rather than sticking around.
        pos: pos || existing.pos,
      }
    : {
        lemma: key,
        status: "new",
        // purpose 故意留空（undefined）——这是 “用户尚未在弹窗里做过选择”
        // 的信号。详情页 <WordDetailView> 检测到本次调用是新建条目
        // 时会强制弹出必选弹窗；用户选完之后由 setPurpose 写入具体值。
        // 读取侧（scheduler / daily-snapshot / 详情页 pill）依旧用
        // `?? "active"` 兜底，保证：
        //   1) 弹窗关闭前的极短窗口内该词临时按 active 处理；
        //   2) 历史存量条目（升级前留下的 undefined）继续按 active 使用。
        queryCount: 1,
        level: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        lastQueriedAt: now,
        pos,
      };
  store[key] = next;
  writeStore(store);
  return next;
}

export function getEntry(lemma: string): WordbookEntry | null {
  return readStore()[lemma.toLowerCase().trim()] ?? null;
}

/** All wordbook entries — useful for the wordbook page on Day 3.
 *  By default omits `archived` so the new/old friend lists stay clean;
 *  pass `{ includeArchived: true }` for the full set. */
export function listEntries(opts?: { includeArchived?: boolean }): WordbookEntry[] {
  const all = Object.values(readStore());
  if (opts?.includeArchived) return all;
  return all.filter((e) => e.status !== "archived");
}

/** Map of lemma → true for words already in the wordbook. Used by the
 *  example-sentence highlighter ("已查过的词高亮"). */
export function getKnownLemmaSet(): Set<string> {
  return new Set(Object.keys(readStore()));
}

/**
 * List the user's known lemmas sorted by MOST RECENTLY queried first.
 * `lastQueriedAt` (search-bar lookups) is preferred over `lastSeenAt`
 * (which also moves on reviews / status changes) so that AI example
 * generation weaves words the user is actively looking up, not words
 * whose Ebbinghaus level was bumped 10 minutes ago.
 *
 * Entries without any lastQueriedAt (batch-imported IELTS words) sort
 * last — they were never actively "queried" and shouldn't dominate the
 * mix used for the AI prompt.
 */
export function listKnownLemmasByRecency(limit: number): string[] {
  const rows = Object.values(readStore());
  const sorted = rows.sort((a, b) => {
    const av = a.lastQueriedAt ?? "";
    const bv = b.lastQueriedAt ?? "";
    if (av && bv) return av < bv ? 1 : -1; // desc
    if (av) return -1;
    if (bv) return 1;
    return 0;
  });
  return sorted.slice(0, Math.max(0, limit)).map((e) => e.lemma);
}

/**
 * Persist the outcome of one review attempt against `lemma`.
 *
 * - level moves +1 on pass / -1 on fail (clamped to [0, 7])
 * - status flips to "old" (毕业) when level reaches 7
 * - nextReviewAt is recomputed from the new level via the scheduler
 *
 * No-ops if the lemma isn't in the wordbook (shouldn't happen for review
 * targets, but defensive).
 */
export function recordReview(
  lemma: string,
  result: "pass" | "fail",
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const nextLevel =
    result === "pass"
      ? Math.min(7, existing.level + 1)
      : Math.max(0, existing.level - 1);
  const now = new Date();
  // Schedule the next due time from the new level. Inline INTERVAL table
  // here to avoid an import cycle with scheduler.ts.
  const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30] as const;
  const next: WordbookEntry = {
    ...existing,
    level: nextLevel,
    status: nextLevel >= 7 ? "old" : existing.status,
    lastSeenAt: now.toISOString(),
    lastReviewedAt: now.toISOString(),
    nextReviewAt:
      nextLevel >= 7
        ? null
        : (() => {
            const d = new Date(now);
            d.setDate(
              d.getDate() +
                INTERVAL_DAYS[Math.min(nextLevel, INTERVAL_DAYS.length - 1)],
            );
            return d.toISOString();
          })(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Toggle / set the lemma's status between "new friend" / "old friend" / "archived".
 * Has no effect (returns null) if the lemma isn't in the wordbook yet —
 * status only makes sense after a first lookup.
 *
 * Level handling per status transition:
 *   - → "old": jump level to 7 (manual graduation; scheduler stops surfacing it).
 *   - → "archived": freeze the current level (so flipping back to "new" later
 *     keeps progress; archived entries don't appear in any review queue anyway).
 *   - → "new":
 *       * From "old": user is saying "I forgot this graduated word, drill me
 *         again". We reset level to 4 (= 7-day interval slot) so the card
 *         needs THREE more successful reviews to re-graduate (4→5→6→7),
 *         and clear nextReviewAt so it surfaces in today's queue immediately.
 *         Going straight back to level 7 on the next pass (the old bug) made
 *         "old → new → review once → old again" trivially achievable.
 *       * From "archived": preserve the frozen level (clamped to ≤ 6 so an
 *         archived-while-graduated entry doesn't auto-graduate again on next
 *         touch). nextReviewAt left alone — caller-visible progress is
 *         whatever it was before archiving.
 *       * From "new" (no-op transition): leave level untouched.
 */
export function setStatus(lemma: string, status: WordbookStatus): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;

  let nextLevel = existing.level;
  let nextReviewAt: string | null | undefined = existing.nextReviewAt;

  if (status === "old") {
    nextLevel = 7;
    nextReviewAt = null; // graduated — never auto-due
  } else if (status === "archived") {
    // Freeze level as-is. Don't touch nextReviewAt either; it's irrelevant
    // while archived (the scheduler filters by status === "new" anyway).
  } else if (status === "new") {
    if (existing.status === "old") {
      // Reactivating a graduated word: drop to level 4 (mid-curve, "记得过
      // 一阵但需要复习"), make it immediately due so the user can practise
      // it today rather than waiting 7 days for the level-4 slot to open.
      nextLevel = 4;
      nextReviewAt = null;
    } else if (existing.status === "archived") {
      // Coming back from 不收藏 — keep level but cap at 6 so it doesn't
      // skip the final review on the next pass.
      nextLevel = Math.min(existing.level, 6);
      // Re-arm the scheduler: if the entry has no due time yet, mark it
      // immediately due (parity with `pickDailyQueue`'s "missing = due").
      if (!nextReviewAt) nextReviewAt = null;
    }
    // status === "new" already → leave level / nextReviewAt untouched.
  }

  const next: WordbookEntry = {
    ...existing,
    status,
    level: nextLevel,
    lastSeenAt: new Date().toISOString(),
    nextReviewAt,
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Set / toggle the word's review-flow purpose ("active" 听说写 vs
 * "passive" 阅读). No-op (returns null) if the lemma isn't in the wordbook
 * yet — purpose only makes sense on a real entry. Level / status /
 * nextReviewAt are all left untouched: the Ebbinghaus schedule is the
 * same for both flows, only the check-in form differs.
 */
export function setPurpose(
  lemma: string,
  purpose: WordbookPurpose,
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const next: WordbookEntry = {
    ...existing,
    purpose,
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Update the snapshot pos on an existing entry. No-op (returns null) if
 * the lemma isn't in the wordbook yet — pos is only meaningful relative
 * to a recorded lookup. Used by the not-found flow where the user picks
 * the part of speech themselves (since there's no dictionary sense to
 * read it from), and may amend it later.
 */
export function setPos(lemma: string, pos: string): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const next: WordbookEntry = { ...existing, pos };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Toggle the IELTS flag on an existing entry. No-op (returns null) if the
 * lemma isn't in the wordbook yet — the flag is meaningful only relative to
 * a recorded entry. Independent of `purpose`: a word can simultaneously be
 * 听说写 and 雅思, or 阅读 and 雅思.
 */
export function setIelts(lemma: string, flag: boolean): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const next: WordbookEntry = {
    ...existing,
    ielts: flag,
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Set the core example / phrase. Trimmed empty string clears the override.
 * No-op if the lemma isn't in the wordbook yet.
 */
export function setCoreExample(
  lemma: string,
  text: string,
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const trimmed = text.trim();
  const now = new Date().toISOString();
  const next: WordbookEntry = {
    ...existing,
    coreExample: trimmed.length > 0 ? trimmed : undefined,
    // Stamp "手动编辑过" so subsequent auto-refills leave this alone.
    // Even clearing the field (trimmed empty) counts as an edit — user
    // explicitly wanted no default.
    coreExampleEditedAt: now,
    lastSeenAt: now,
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Refill an entry's coreExample if the user hasn't manually edited it.
 * Used by the one-shot v2 migration that re-derives defaults after the
 * pick-priority changed (词义区例句 > 常用搭配区). Skips entries with
 * `coreExampleEditedAt` set (user override). Empty defaultExample is a
 * no-op — we never wipe an existing value with nothing.
 */
export function refillCoreExampleIfDefault(
  lemma: string,
  defaultExample: string,
): WordbookEntry | null {
  const trimmed = defaultExample.trim();
  if (!trimmed) return null;
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  if (existing.coreExampleEditedAt) return existing; // manually edited — leave alone
  if (existing.coreExample === trimmed) return existing; // already matches
  const next: WordbookEntry = { ...existing, coreExample: trimmed };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Set the IELTS import group name. Empty string clears the group.
 * No-op if the lemma isn't in the wordbook yet.
 */
export function setGroup(
  lemma: string,
  group: string,
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const trimmed = group.trim();
  const next: WordbookEntry = {
    ...existing,
    group: trimmed.length > 0 ? trimmed : undefined,
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * Batch-normalize IELTS import groups.
 *
 * Motivation: 真经-学校教育1 / 真经-学校教育2 / 真经-学校教育 3 were imported
 * as separate groups. The user wants them collapsed to a single group by
 * stripping trailing digits (and any punctuation immediately before those
 * digits). Also, "真经-历史文明" is explicitly aliased to "真经-历史文化"
 * per user request.
 *
 * Safety:
 *   - Only groups starting with the "真经-" prefix are touched, so any
 *     hand-typed user group stays intact.
 *   - Entries without a group are ignored.
 *
 * Returns the number of entries whose `group` was changed.
 */
export function normalizeIeltsGroups(): number {
  const store = readStore();
  const nowIso = new Date().toISOString();
  let changed = 0;
  const IELTS_PREFIX = "真经-";
  // Manual alias table for cases that don't fit the "strip digits" rule.
  // These are matched BEFORE the prefix guard so groups without the
  // "真经-" prefix (e.g. historical import of "娱乐运动") can be lifted
  // into the ielts namespace.
  const ALIASES: Record<string, string> = {
    "真经-历史文明": "真经-历史文化",
    "娱乐运动": "真经-娱乐运动",
  };
  for (const key of Object.keys(store)) {
    const entry = store[key];
    const g = entry.group?.trim();
    if (!g) continue;

    // Step 1: apply explicit aliases first (bypasses the prefix guard).
    if (ALIASES[g]) {
      const aliased = ALIASES[g];
      if (aliased !== g) {
        store[key] = { ...entry, group: aliased, lastSeenAt: nowIso };
        changed += 1;
      }
      continue;
    }

    // Step 2: only strip digits from ielts-prefixed groups, so hand-typed
    // user groups stay intact.
    if (!g.startsWith(IELTS_PREFIX)) continue;

    //   "真经-学校教育1"   → "真经-学校教育"
    //   "真经-学校教育 3"  → "真经-学校教育"
    //   "真经-学校教育-2"  → "真经-学校教育"
    //   "真经-学校教育"    → "真经-学校教育" (no change)
    let normalized = g.replace(/[\s\-_]*\d+$/, "").trim();

    // Step 3: apply aliases again after digit-strip (covers cases like
    // "真经-历史文明1" → "真经-历史文明" → "真经-历史文化").
    if (ALIASES[normalized]) normalized = ALIASES[normalized];

    if (normalized && normalized !== g) {
      store[key] = { ...entry, group: normalized, lastSeenAt: nowIso };
      changed += 1;
    }
  }
  if (changed > 0) writeStore(store);
  return changed;
}
/**
 * Record the outcome of a review attempt on stats (reviewCount / errorCount /
 * inWrongBook), independent from `recordReview()` which handles the
 * Ebbinghaus level & schedule. This is called AFTER recordReview so both
 * sets of stats stay in sync.
 *
 * Rules (per product spec):
 *   - reviewCount += 1 always (both pass and fail).
 *   - fail → errorCount += 1, inWrongBook = true.
 *   - pass:
 *       * if opts.fromWrongBook === true (重温错词) → inWrongBook = false;
 *         errorCount is NOT changed (historical count is immutable).
 *       * otherwise → inWrongBook untouched, errorCount untouched.
 */
export function recordReviewStats(
  lemma: string,
  result: "pass" | "fail",
  opts?: { fromWrongBook?: boolean },
): WordbookEntry | null {
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  const prevReview = existing.reviewCount ?? 0;
  const prevError = existing.errorCount ?? 0;
  const prevInWrong = existing.inWrongBook === true;
  let nextError = prevError;
  let nextInWrong = prevInWrong;
  if (result === "fail") {
    nextError = prevError + 1;
    nextInWrong = true;
  } else if (opts?.fromWrongBook) {
    // Successful re-review from wrong-book → remove from wrong-book.
    nextInWrong = false;
  }
  const next: WordbookEntry = {
    ...existing,
    reviewCount: prevReview + 1,
    errorCount: nextError,
    inWrongBook: nextInWrong,
    lastSeenAt: new Date().toISOString(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

/**
 * One-shot store migration: backfill new fields on legacy rows.
 * Idempotent — safe to call on every app load.
 *   - reviewCount → 0 if missing
 *   - errorCount → 0 if missing
 *   - inWrongBook → false if missing
 *  (coreExample is left as-is; the caller is responsible for backfilling
 *  it from the dictionary at load time, since this module has no dict
 *  access.)
 */
export function migrateEntries(): void {
  if (typeof window === "undefined") return;
  const store = readStore();
  let dirty = false;
  for (const [key, entry] of Object.entries(store)) {
    let changed = false;
    const patched: WordbookEntry = { ...entry };
    if (patched.reviewCount === undefined) {
      patched.reviewCount = 0;
      changed = true;
    }
    if (patched.errorCount === undefined) {
      patched.errorCount = 0;
      changed = true;
    }
    if (patched.inWrongBook === undefined) {
      patched.inWrongBook = false;
      changed = true;
    }
    if (changed) {
      store[key] = patched;
      dirty = true;
    }
  }
  if (dirty) writeStore(store);
}

/**
 * Backfill a single entry's coreExample if it's currently empty.
 * Caller resolves the default text from the dictionary and passes it in.
 * No-op if the entry doesn't exist or already has a coreExample.
 */
export function backfillCoreExample(
  lemma: string,
  defaultExample: string,
): WordbookEntry | null {
  const trimmed = defaultExample.trim();
  if (!trimmed) return null;
  const key = lemma.toLowerCase().trim();
  const store = readStore();
  const existing = store[key];
  if (!existing) return null;
  if (existing.coreExample && existing.coreExample.trim().length > 0) {
    return existing;
  }
  const next: WordbookEntry = { ...existing, coreExample: trimmed };
  store[key] = next;
  writeStore(store);
  return next;
}

// ---------------------------------------------------------------------------
// notes CRUD
// ---------------------------------------------------------------------------

export function listNotes(lemma: string): WordNote[] {
  const key = lemma.toLowerCase().trim();
  const notes = readNotes()[key] ?? [];
  // newest first — that's what the user wrote most recently
  return [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function addNote(
  lemma: string,
  body: string,
  image?: string,
): WordNote {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key] ?? [];
  const now = new Date().toISOString();
  const note: WordNote = {
    // crypto.randomUUID exists in all evergreen browsers; fall back to a
    // timestamp-based id if we're somehow on an ancient one.
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    lemma: key,
    body,
    image,
    createdAt: now,
    updatedAt: now,
  };
  all[key] = [note, ...list];
  writeNotes(all);
  return note;
}

export function updateNote(
  lemma: string,
  id: string,
  patch: { body?: string; image?: string | null },
): WordNote | null {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key];
  if (!list) return null;
  const idx = list.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const prev = list[idx];
  const next: WordNote = {
    ...prev,
    body: patch.body ?? prev.body,
    image: patch.image === null ? undefined : patch.image ?? prev.image,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = next;
  writeNotes(all);
  return next;
}

export function deleteNote(lemma: string, id: string): boolean {
  const key = lemma.toLowerCase().trim();
  const all = readNotes();
  const list = all[key];
  if (!list) return false;
  const next = list.filter((n) => n.id !== id);
  if (next.length === list.length) return false;
  all[key] = next;
  writeNotes(all);
  return true;
}
