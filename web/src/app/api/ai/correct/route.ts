/**
 * POST /api/ai/correct
 *
 * IELTS/PTE-examiner-style English sentence feedback for a Chinese B2
 * learner. The API deliberately runs on a **two-track model** so the
 * learner never confuses "wrong" with "could be more idiomatic":
 *
 *   Track A — ERRORS (`ok`, `segments`, `diagnosis`)
 *     Only things that an IELTS / PTE examiner would actually deduct
 *     marks for: a violation of a NAMEABLE, WRITTEN rule of English
 *     grammar / lexis / spelling, or a breakdown in communication.
 *     If the learner's phrasing can be defended by any real rule, it
 *     is NOT an error, no matter how "un-idiomatic" it sounds.
 *
 *   Track B — STYLE SUGGESTIONS (`suggestions`)
 *     Alternative wordings that are more idiomatic or higher-register.
 *     These are LEARNING OPPORTUNITIES, NOT errors — they never flip
 *     `ok` to false and they never appear in `segments`.
 *
 * Verdicts:
 *   - ok=true   → No examiner-flagged error. `suggestions` may still
 *                 offer idiomatic upgrades; they don't cost the
 *                 learner marks.
 *   - ok=false  → At least one examiner-flagged error, each one
 *                 accompanied by a citable `rule` in `diagnosis`.
 *
 * Response body:
 *   {
 *     ok: boolean,
 *     recommended: string,             // native-quality rewrite (or upgrade)
 *     recommendedAlt?: string,         // optional second option (different register)
 *     segments: Array<{                // diff over the ORIGINAL sentence; concatenating
 *       text: string,                  // .text reproduces the original verbatim.
 *       wrong?: boolean,               // only set when ok=false — indicates a
 *       fix?: string,                  // REAL examiner-grade error, not a style call.
 *     }>,
 *     diagnosis: string[],             // one short Chinese line per flagged error;
 *                                      // each MUST cite the named rule that was
 *                                      // violated ("subject-verb agreement",
 *                                      // "countable noun requires a determiner",
 *                                      // etc.).
 *     suggestions?: Array<{            // Track-B style advice; never errors.
 *       text: string,                  // The more idiomatic wording.
 *       reason: string,                // 1-line Chinese rationale.
 *     }>,
 *     distinction?: string,            // 1-line confusable-word disambiguation (Chinese)
 *     ielts?: string,                  // 1 native-level IELTS-speaking sample sentence
 *     provider: "deepseek" | "mock"
 *   }
 *
 * Falls back to a deterministic mock when DEEPSEEK_API_KEY is unset.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface SenseHint {
  def?: string;
  chn?: string;
  pos?: string;
}

interface RequestBody {
  lemma: string;
  sense?: SenseHint;
  sentence: string;
}

interface Segment {
  text: string;
  wrong?: boolean;
  fix?: string;
}

interface Suggestion {
  text: string;
  reason: string;
}

interface ResponseBody {
  ok: boolean;
  recommended: string;
  recommendedAlt?: string;
  segments: Segment[];
  diagnosis: string[];
  suggestions?: Suggestion[];
  distinction?: string;
  ielts?: string;
  provider: "deepseek" | "mock";
}

/** Resolve the OpenAI-compatible chat-completions URL from env, tolerating
 *  base URLs given with or without a trailing `/v1` and with or without the
 *  `/chat/completions` suffix. */
function resolveChatUrl(): string {
  const raw = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(raw)) return raw;
  if (/\/v\d+$/.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}
const CHAT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

function buildPrompt(lemma: string, sentence: string, sense?: SenseHint) {
  const senseLine = sense?.def
    ? `Target sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Target sense: most common.";
  return [
    "You are a CERTIFIED IELTS Writing / PTE Writing examiner grading",
    "one sentence produced by a Chinese B2 learner. Your judgement must",
    "line up with the published IELTS Writing Band Descriptors and PTE",
    "Enabling Skills — NOT with your personal taste, and NOT with what",
    "\"a native speaker would prefer\". Examiners do not deduct marks for",
    "phrasings they find un-idiomatic; they deduct marks for concrete,",
    "citable rule violations. Neither should you.",
    "",
    `Target word: "${lemma}". ${senseLine}`,
    `Learner's sentence: """${sentence}"""`,
    "",
    "════════════════════════════════════════════════════════════════",
    "TWO-TRACK OUTPUT — read this before anything else.",
    "════════════════════════════════════════════════════════════════",
    "  TRACK A — ERRORS (drives `ok`, `segments`, `diagnosis`).",
    "     A learner sentence contains an ERROR iff, and only iff, an",
    "     examiner could point to a NAMED, WRITTEN rule of English and",
    "     say \"this violates <rule>\". If you cannot name the rule in",
    "     standard examiner terminology, IT IS NOT AN ERROR — even if",
    "     the sentence \"sounds off\" to you.",
    "",
    "  TRACK B — STYLE SUGGESTIONS (`suggestions`).",
    "     Anything that is not an error but that you would still like to",
    "     teach — a more idiomatic collocation, a higher-register verb,",
    "     a tighter construction — goes here. Suggestions do NOT flip",
    "     `ok` to false. They do NOT appear in `segments`. They live in",
    "     their own list.",
    "",
    "  Mixing the two tracks is the single biggest failure mode of this",
    "  API. Do not do it. If in doubt, downgrade Track A → Track B.",
    "",
    "════════════════════════════════════════════════════════════════",
    "SCOPE OF TRACK-A ERRORS — the ONLY four families that count.",
    "════════════════════════════════════════════════════════════════",
    "  G1  GRAMMAR VIOLATION.  Must cite a specific rule that appears",
    "      in a standard grammar reference (Cambridge Grammar, Swan's",
    "      Practical English Usage, IELTS Writing rubric). Examples of",
    "      acceptable rule names:",
    "        - subject-verb agreement",
    "        - tense / aspect consistency",
    "        - a singular countable noun requires a determiner",
    "        - the verb `discuss` is transitive and takes no preposition",
    "        - `interested` (feeling) vs `interesting` (property)",
    "        - conditional-clause sequence of tenses",
    "",
    "  G2  LEXICAL INCOMPATIBILITY.  A specific dictionary-attested",
    "      violation: wrong part of speech, wrong argument structure,",
    "      or a collocation flagged as wrong (not merely uncommon) by",
    "      a learner's dictionary. \"`make` a photo\" is G2. \"`enjoy` to",
    "      do sth\" is G2 (`enjoy` requires -ing). \"Nice weather\" vs",
    "      \"good weather\" is NOT G2 — both are attested.",
    "",
    "  G3  SPELLING.  The written form does not exist in any major",
    "      dictionary (`recieve`, `seperate`). British/American variants",
    "      are BOTH correct — never flag `colour` vs `color`.",
    "",
    "  G4  COMMUNICATION BREAKDOWN.  Word order or missing constituents",
    "      make the intended meaning unrecoverable, or force a strongly",
    "      unintended reading. Rare in a single learner sentence.",
    "",
    "════════════════════════════════════════════════════════════════",
    "OUT OF SCOPE — NEVER flag these as Track-A errors.",
    "════════════════════════════════════════════════════════════════",
    "  X1  \"A native speaker would say it differently.\"  ← Track B only.",
    "  X2  \"There is a more idiomatic collocation.\"        ← Track B only.",
    "  X3  \"This word is uncommon here / feels unnatural.\" ← Track B only.",
    "  X4  Number / article / tense choices that have MORE THAN ONE",
    "      defensible reading. Example: \"I want to change majors\" and",
    "      \"I want to change my major\" are BOTH correct English — do",
    "      NOT flag either. If you can construct a real context in",
    "      which the learner's form is grammatical, IT IS NOT AN ERROR.",
    "  X5  Register mismatch, unless the task explicitly demands a",
    "      specific register (this one does not).",
    "  X6  Anything you cannot name a rule for. \"It just feels wrong\"",
    "      is not a rule.",
    "",
    "════════════════════════════════════════════════════════════════",
    "MANDATORY DECISION PROTOCOL — walk this for every candidate error",
    "before you commit to marking it.",
    "════════════════════════════════════════════════════════════════",
    "  S1  Name the rule.  Which of G1–G4 does the candidate violate,",
    "      and what is the exact rule name (in English, examiner terms)?",
    "      If you cannot fill in that name → STOP, do not mark.",
    "  S2  Defensibility check.  Can the learner's form be defended by",
    "      any real rule of English, in any reasonable interpretation?",
    "      If yes → STOP, do not mark. Move it to Track B if you still",
    "      want to teach the alternative.",
    "  S3  Fix vs upgrade check.  Is your proposed replacement a FIX",
    "      (removes the rule violation) or an UPGRADE (same rules, nicer",
    "      wording)? If upgrade → STOP, move to Track B.",
    "  S4  Consistency check.  Would a different competent examiner,",
    "      given only your rule name from S1, arrive at the SAME verdict?",
    "      If your justification is 'it sounds better' — the answer is",
    "      no. Move to Track B.",
    "",
    "  Only after all four checks pass may you place the segment in",
    "  `segments` with `wrong:true` and add a Chinese line to",
    "  `diagnosis` that quotes the rule name in backticks.",
    "",
    "════════════════════════════════════════════════════════════════",
    "EXHAUSTIVENESS — when there ARE errors, catch them all in one pass.",
    "════════════════════════════════════════════════════════════════",
    "  If the sentence contains multiple independent Track-A errors,",
    "  report every one of them in this response — never surface just",
    "  the most obvious and leave the rest for a later turn. Before",
    "  emitting JSON, silently re-scan the sentence against G1–G4",
    "  end-to-end. Each independent error becomes its own `wrong`",
    "  segment AND its own `diagnosis` bullet. `recommended` must",
    "  integrate every fix. Exhaustiveness applies to REAL errors",
    "  only; it does NOT license you to promote Track-B upgrades",
    "  into Track-A errors just to fill the list.",
    "",
    "════════════════════════════════════════════════════════════════",
    "STATELESSNESS & ANTI-REVERSAL.",
    "════════════════════════════════════════════════════════════════",
    "  You have no memory of previous turns. That is fine, because",
    "  your decisions must be reproducible from THE RULES ALONE — not",
    "  from your language intuition (which drifts between turns and",
    "  causes the notorious flip-flop where a form is marked wrong on",
    "  turn N and right on turn N+1). Follow S1–S4 and your verdict",
    "  will be stable across turns by construction.",
    "",
    "  INFLECTIONS: any inflected form of the target word counts as",
    "  using it (plurals, past tense, gerund, irregular forms). Do NOT",
    "  reject just because the user wrote an inflection.",
    "",
    "════════════════════════════════════════════════════════════════",
    "WORKED EXAMPLES — calibrate against these.",
    "════════════════════════════════════════════════════════════════",
    '  E1  "I want to change majors."',
    "      Rule check: `major` is a countable noun; both `change majors`",
    "      (plural, generic) and `change my major` (singular, specific)",
    "      are attested. → NO Track-A error. `ok=true`. Optionally add",
    "      a Track-B suggestion if you want to teach the alternative.",
    "",
    '  E2  "I am interesting in music."',
    "      Rule check (G1): `-ing` participles describe the property",
    "      that causes the feeling; `-ed` participles describe the",
    "      feeling itself. Learner needs `interested`. Rule name:",
    "      \"-ing vs -ed participial adjectives\". → Track-A error.",
    "",
    '  E3  "Yesterday I go to a musics concert and I very enjoy it."',
    "      Three independent Track-A errors, ALL reported at once:",
    "        (i)  tense: `go` → `went`  (past-tense marker `yesterday`)",
    "        (ii) noun form: `a musics concert` → `a music concert`",
    "             (`music` is uncountable and attributive)",
    "        (iii) adverb placement / collocation: `I very enjoy it`",
    "              → `I really enjoyed it` (`very` doesn't modify verbs)",
    "",
    '  E4  "I like listening to symphony."',
    "      Rule check (G1): `symphony` is countable; a singular",
    "      countable in generic reference needs plural or a determiner",
    "      → `symphonies` or `a symphony`. Rule name: \"countable noun",
    "      requires plural or determiner in generic reference\".",
    "      → Track-A error.",
    "",
    '  E5  "I like listening to symphonies."',
    "      Rule check: all rules satisfied. → `ok=true`, `suggestions`",
    "      MAY offer \"I enjoy listening to classical symphonies\" as a",
    "      register upgrade, but that is Track B.",
    "",
    "════════════════════════════════════════════════════════════════",
    "OUTPUT SCHEMA — fields you must produce.",
    "════════════════════════════════════════════════════════════════",
    "  recommended     : the native-quality version. When ok=false, it",
    "                    integrates every Track-A fix. When ok=true, it",
    "                    MAY equal the learner's sentence verbatim; only",
    "                    change it if there is a clearly better wording",
    "                    worth teaching (that alternative is then also",
    "                    the first entry of `suggestions`, so the",
    "                    learner sees the reason).",
    "  recommendedAlt  : (optional) a second rewrite in a different",
    "                    register. Skip when redundant.",
    "  segments        : ordered diff over the ORIGINAL sentence.",
    "                    Concatenating each `.text` MUST reproduce the",
    "                    original verbatim. When ok=false, wrap each",
    "                    Track-A error in {wrong:true, fix:'…'}; leave",
    "                    the rest as plain {text:'…'}. When ok=true,",
    "                    output a SINGLE segment containing the whole",
    "                    original with NO `wrong` flag. Never place a",
    "                    Track-B suggestion in `segments`.",
    "  diagnosis       : array of short Chinese lines, one PER Track-A",
    "                    error you flagged. Each line MUST contain the",
    "                    English rule name in backticks (e.g. `subject-",
    "                    verb agreement`, `countable noun determiner`)",
    "                    so the learner — and future you — can audit the",
    "                    decision. If ok=true, `diagnosis` MUST be `[]`.",
    "  suggestions     : (optional) array of Track-B style upgrades,",
    '                    each shaped as {"text":"<English rewrite>",',
    '                    "reason":"<中文一句>"}. Reason should explain',
    "                    what the upgrade teaches (a collocation, a",
    "                    more precise verb, a tighter construction),",
    "                    NEVER \"the original is wrong\". Give at most 2.",
    "                    Skip entirely if you have no genuine upgrade.",
    "  distinction     : (optional) a single Chinese line disambiguating",
    "                    two confusable words relevant here.",
    '                    Format: "`A` = …；`B` = …". Skip if not useful.',
    "  ielts           : (optional) ONE English sample sentence at IELTS",
    "                    Band 7+ level, built around the target word.",
    "",
    "════════════════════════════════════════════════════════════════",
    "STRICT RULES.",
    "════════════════════════════════════════════════════════════════",
    "  (R1) Be concise. No markdown, no bullet chars, no headings in",
    "       any field. Diagnosis and reason lines are ONE sentence each.",
    "  (R2) Every `diagnosis` entry MUST cite a rule name in backticks.",
    "       If you cannot cite one, the underlying segment does not",
    "       belong in `segments` as `wrong` — remove it (S1 failure).",
    "  (R3) Track-A `wrong` segments must be MINIMAL in span (just the",
    "       offending words). This constrains span WIDTH, not the",
    "       number of errors reported.",
    "  (R4) `recommended` must retain the target word (or an inflection).",
    "       Never silently swap it out.",
    "  (R5) NEVER fabricate a rule. If you catch yourself writing a",
    "       diagnosis like \"this noun should not be plural here\" without",
    "       being able to name the underlying rule, you have failed S1.",
    "       Delete the segment and, if you still care, move the",
    "       alternative wording to `suggestions`.",
    "  (R6) NEVER promote a Track-B upgrade into a Track-A error. If",
    "       your only justification is \"sounds more natural\" / \"more",
    "       common\" / \"native speakers prefer\", it is Track B.",
    "  (R7) When ok=true you MAY omit `suggestions`, `distinction`,",
    "       `ielts` entirely — silence beats noise.",
    "  (R8) FINAL SELF-CHECK before returning:",
    "         a) For every `wrong` segment, can I state its rule name?",
    "            If no → drop it, possibly move to `suggestions`.",
    "         b) Are there any Track-A errors I have NOT yet flagged?",
    "            If yes → add them now; update `recommended`.",
    "         c) Is `ok` consistent with `segments`? (`ok=true` ⇔ no",
    "            `wrong` segments, `diagnosis=[]`.)",
    "",
    "Reply with ONLY a JSON object, no markdown, no commentary:",
    "{",
    '  "ok": true|false,',
    '  "recommended": "<one English sentence>",',
    '  "recommendedAlt": "<optional English sentence>",',
    '  "segments": [{"text":"…"}, {"text":"…","wrong":true,"fix":"…"}],',
    '  "diagnosis": ["<中文一句，含 `rule name` in backticks>"],',
    '  "suggestions": [{"text":"<English rewrite>","reason":"<中文一句>"}],',
    '  "distinction": "<optional 中文一句>",',
    '  "ielts": "<optional English sentence>"',
    "}",
  ].join("\n");
}

function extractJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Mock heuristic correction (no API key path):
 *   - If the lemma appears in any inflected form, treat as "good" with a
 *     templated upgrade.
 *   - Otherwise mark the whole sentence wrong.
 *
 * This isn't smart — it only exercises every UI code path so we can verify
 * the new coach-style layout end-to-end.
 */
interface Lemmatizer {
  noun: (s: string) => string;
  verb: (s: string) => string;
  adjective: (s: string) => string;
}

let lemmatizerCache: Lemmatizer | null | undefined;
async function loadLemmatizer(): Promise<Lemmatizer | null> {
  if (lemmatizerCache !== undefined) return lemmatizerCache;
  try {
    const mod = (await import("wink-lemmatizer")) as unknown as {
      default?: Lemmatizer;
    } & Lemmatizer;
    lemmatizerCache = (mod.default ?? mod) as Lemmatizer;
  } catch {
    lemmatizerCache = null;
  }
  return lemmatizerCache;
}

function sentenceMentionsLemma(
  lemma: string,
  sentence: string,
  lem: Lemmatizer | null,
): boolean {
  const target = lemma.toLowerCase();
  const re = new RegExp(
    `\\b${target.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(s|es|ed|ing|d)?\\b`,
    "i",
  );
  if (re.test(sentence)) return true;
  if (!lem) return false;
  const words = sentence.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  for (const w of words) {
    try {
      if (lem.verb(w) === target) return true;
    } catch {
      /* ignore */
    }
    try {
      if (lem.noun(w) === target) return true;
    } catch {
      /* ignore */
    }
    try {
      if (lem.adjective(w) === target) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function mockCorrect(
  lemma: string,
  sentence: string,
  sense?: SenseHint,
): Promise<ResponseBody> {
  const lem = await loadLemmatizer();
  if (sentenceMentionsLemma(lemma, sentence, lem) && sentence.trim().length > 5) {
    return {
      ok: true,
      recommended: sentence,
      segments: [{ text: sentence }],
      diagnosis: [
        `用法看起来没问题，符合「${sense?.chn ?? lemma}」的释义。（mock 模式未提供升级版本）`,
      ],
      provider: "mock",
    };
  }
  return {
    ok: false,
    recommended: `She decided to ${lemma} the project.`,
    segments: [
      { text: sentence, wrong: true, fix: `She decided to ${lemma} the project.` },
    ],
    diagnosis: [`句子里没有出现 \`${lemma}\`（或任何词形变化），建议改写。`],
    provider: "mock",
  };
}

/** Sanitise the model's JSON into a strict ResponseBody. */
function normaliseResponse(parsed: unknown, sentence: string): Omit<ResponseBody, "provider"> {
  const p = (parsed ?? {}) as Record<string, unknown>;
  let ok = Boolean(p.ok);
  const recommended =
    typeof p.recommended === "string" && p.recommended.trim()
      ? p.recommended.trim()
      : sentence;
  const recommendedAlt =
    typeof p.recommendedAlt === "string" && p.recommendedAlt.trim()
      ? p.recommendedAlt.trim()
      : undefined;
  const segments: Segment[] = Array.isArray(p.segments)
    ? (p.segments as unknown[])
        .map((s) => {
          const seg = (s ?? {}) as Record<string, unknown>;
          return {
            text: String(seg.text ?? ""),
            wrong: Boolean(seg.wrong),
            fix: seg.fix !== undefined ? String(seg.fix) : undefined,
          };
        })
        .filter((s) => s.text.length > 0)
    : [{ text: sentence }];

  const diagnosisRaw: string[] = Array.isArray(p.diagnosis)
    ? (p.diagnosis as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
    : [];

  // ── Rule-citation guardrail ────────────────────────────────────────────
  // The prompt requires every `diagnosis` line to contain a rule name in
  // backticks (see R2 / R5 in buildPrompt). If the model returns ok=false
  // but no diagnosis line actually cites a rule, that is a failed S1 —
  // we do NOT trust the verdict and downgrade to ok=true. This is the
  // structural fence that stops the model from inventing rules or
  // flip-flopping on grey-area calls.
  const hasCitedRule = diagnosisRaw.some((d) => /`[^`]+`/.test(d));
  if (!ok && !hasCitedRule) {
    ok = true;
  }

  // If the model said ok=true (or we just forced it), scrub any wrong flags.
  if (ok) {
    for (const s of segments) {
      s.wrong = false;
      s.fix = undefined;
    }
  }

  // When ok=true, diagnosis MUST be empty per contract.
  const diagnosis: string[] = ok ? [] : diagnosisRaw.slice(0, 4);

  const suggestions: Suggestion[] | undefined = Array.isArray(p.suggestions)
    ? ((p.suggestions as unknown[])
        .map((s) => {
          const sg = (s ?? {}) as Record<string, unknown>;
          const text = String(sg.text ?? "").trim();
          const reason = String(sg.reason ?? "").trim();
          if (!text || !reason) return null;
          return { text, reason } as Suggestion;
        })
        .filter((s): s is Suggestion => s !== null)
        .slice(0, 2)) || undefined
    : undefined;
  const suggestionsClean =
    suggestions && suggestions.length > 0 ? suggestions : undefined;

  const distinction =
    typeof p.distinction === "string" && p.distinction.trim()
      ? p.distinction.trim()
      : undefined;
  const ielts =
    typeof p.ielts === "string" && p.ielts.trim()
      ? p.ielts.trim()
      : undefined;
  return {
    ok,
    recommended,
    recommendedAlt,
    segments,
    diagnosis,
    suggestions: suggestionsClean,
    distinction,
    ielts,
  };
}

async function callDeepseek(
  lemma: string,
  sentence: string,
  sense: SenseHint | undefined,
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(lemma, sentence, sense);
  const res = await fetch(resolveChatUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deepseek ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonStr = extractJson(content);
  if (!jsonStr) throw new Error(`deepseek returned non-JSON: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(jsonStr) as unknown;
  return { ...normaliseResponse(parsed, sentence), provider: "deepseek" };
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const lemma = String(body.lemma ?? "").trim().toLowerCase();
  const sentence = String(body.sentence ?? "").trim();
  if (!lemma || !/^[a-z][a-z\-'\s]{0,40}$/.test(lemma)) {
    return NextResponse.json({ error: "invalid lemma" }, { status: 400 });
  }
  if (!sentence) {
    return NextResponse.json({ error: "empty sentence" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(await mockCorrect(lemma, sentence, body.sense));
  }
  try {
    return NextResponse.json(
      await callDeepseek(lemma, sentence, body.sense, apiKey),
    );
  } catch (err) {
    console.error("[ai/correct] deepseek call failed:", err);
    return NextResponse.json({
      ...(await mockCorrect(lemma, sentence, body.sense)),
      provider: "mock",
    });
  }
}
