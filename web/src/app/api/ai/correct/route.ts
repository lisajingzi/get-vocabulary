/**
 * POST /api/ai/correct
 *
 * Coach-style English sentence feedback for a Chinese B2 learner who is
 * preparing for IELTS speaking. We do NOT operate as a binary "right/wrong"
 * grader — we operate as a tutor that always nudges the learner toward more
 * native-like phrasing, even when the original sentence is grammatically
 * fine.
 *
 * Two verdicts only:
 *   - ok=true  ("good")        → original is already native-like; we still
 *                                offer a slightly more advanced/idiomatic
 *                                upgrade in `recommended` so the learner
 *                                keeps levelling up.
 *   - ok=false ("needs_work")  → anything from a real grammar bug to a
 *                                merely-understandable-but-unnatural
 *                                collocation. We always rewrite to a
 *                                native-quality version.
 *
 * Response body:
 *   {
 *     ok: boolean,
 *     recommended: string,           // most natural rewrite (or upgrade)
 *     recommendedAlt?: string,       // optional second option (different register)
 *     segments: Array<{              // diff over the ORIGINAL sentence; concatenating
 *       text: string,                // .text reproduces the original verbatim.
 *       wrong?: boolean,             // only set when ok=false
 *       fix?: string,
 *     }>,
 *     diagnosis: string[],           // 1-2 short Chinese explanations of the language point(s)
 *     distinction?: string,          // 1-line confusable-word disambiguation (Chinese)
 *     ielts?: string,                // 1 native-level IELTS-speaking sample sentence
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

interface ResponseBody {
  ok: boolean;
  recommended: string;
  recommendedAlt?: string;
  segments: Segment[];
  diagnosis: string[];
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
    "You are an English LANGUAGE COACH (not a grammar checker) for a Chinese",
    "B2 learner who is preparing for IELTS speaking. Your goal is to help",
    "the learner sound MORE NATIVE — not merely to verify that a sentence",
    "is parseable.",
    "",
    `Target word: "${lemma}". ${senseLine}`,
    `Learner's sentence: """${sentence}"""`,
    "",
    "TWO-TIER VERDICT (no middle ground):",
    "  - ok=true  → A native speaker WOULD ACTUALLY SAY THIS sentence.",
    "                It is grammatical, idiomatic, and uses the target word",
    "                in the requested sense. The bar is NOT \"the best",
    "                possible phrasing\" — it is \"a phrasing a native would",
    "                naturally produce in casual speech\". If yes, ok=true.",
    "                In this case `recommended` MAY be IDENTICAL to the",
    "                learner's sentence; only suggest an upgrade if there",
    "                is a clearly more idiomatic / higher-register version",
    "                worth teaching. You MUST NOT mark any segments as",
    "                wrong (segments = [{text: <whole original>}]).",
    "  - ok=false → ANY of: real grammar bug, wrong sense of the target",
    "                word, wrong part of speech, missing/extra article on",
    "                a countable noun, broken collocation, or a phrasing",
    "                native speakers would NOT produce. \"Slightly less",
    "                elegant than the optimum\" is NOT a reason for false.",
    "                Mark the broken segments and propose a native-quality",
    "                `recommended` rewrite.",
    "",
    "ANTI-NITPICK GUARD (read carefully):",
    "  The learner often resubmits sentences that you yourself recommended",
    "  in a previous turn. You are stateless across turns, so don't assume",
    "  context — just judge each sentence on its own merits. Crucially, if",
    "  a sentence is already in the \"native would say this\" zone, you",
    "  MUST return ok=true even though some other phrasing might score",
    "  half a point higher on style. Do not chain endless micro-upgrades.",
    "  Concrete anchors:",
    '    - "I like listening to symphonies."        → ok=true (native says this)',
    '    - "I enjoy listening to classical music."  → ok=true',
    '    - "I like to listen to symphony."          → ok=false (countable-noun bug)',
    '    - "I am interesting in music."             → ok=false (wrong adjective form)',
    "",
    "INFLECTIONS: any inflected form of the target word counts as using it",
    "(plurals, past tense, gerund, irregular forms — e.g. \"ran\" for \"run\").",
    "Do NOT reject merely because the user wrote an inflection.",
    "",
    "OUTPUT — produce all of the following:",
    "  recommended      : the most natural English sentence for this idea.",
    "                     When ok=true, this MAY be identical to the",
    "                     learner's sentence; ONLY suggest a different",
    "                     wording if it is clearly more idiomatic or",
    "                     teaches a useful higher-register option. Don't",
    "                     invent micro-upgrades just to fill the field.",
    "                     When ok=false, this is your native-quality",
    "                     rewrite. Keep it CLOSE to what the learner",
    "                     tried to say — don't change the topic.",
    "  recommendedAlt   : (optional) one additional option in a DIFFERENT",
    "                     register or with a different common collocation.",
    "                     Skip if there is no genuinely useful alternative.",
    "  segments         : ordered diff over the ORIGINAL sentence. Concatenating",
    "                     each .text MUST reproduce the original verbatim.",
    "                     When ok=false, mark broken stretches with",
    "                     {wrong:true, fix:'<corrected words>'} and keep",
    "                     correct stretches as plain {text:'…'}.",
    "                     When ok=true, output a single segment containing",
    "                     the whole original sentence and no `wrong` flag.",
    "  diagnosis        : array of 1–2 SHORT Chinese sentences, each explaining",
    "                     ONE concrete language point — e.g. countability,",
    "                     article rule, tense, collocation. Cite the offending",
    "                     word in English in backticks. Example:",
    '                     "`symphony` 是可数名词，泛指这类作品时用复数 `symphonies`，指某一首时用 `a symphony`。"',
    "                     When ok=true and `recommended` equals the original,",
    "                     `diagnosis` MAY be an empty array []. When ok=true",
    "                     with a different `recommended`, give 1 sentence",
    "                     explaining WHY the upgrade sounds more natural.",
    "  distinction      : (optional) a SINGLE Chinese sentence distinguishing",
    "                     two confusable words/phrases that are relevant to",
    "                     this sentence (e.g. symphony vs classical music).",
    "                     Format: \"`A` = …；`B` = …\". Skip if not useful.",
    "  ielts            : (optional, but encouraged) ONE English sample",
    "                     sentence at IELTS Band 7+ level that the learner",
    "                     could reuse in IELTS speaking, built around the",
    "                     same topic and the target word. Keep it natural,",
    "                     not over-decorated.",
    "",
    "STRICT RULES:",
    "  (R1) Be CONCISE. Each diagnosis item is one sentence. No bullet",
    "       lists in any field, no markdown, no headings.",
    "  (R2) Do NOT correct stylistic preferences. Only flag things a native",
    "       speaker would actually say differently.",
    "  (R3) When ok=false, the `wrong` segments must be MINIMAL — just the",
    "       offending span, not the whole clause.",
    "  (R4) `recommended` must keep the target word (or its inflection).",
    "       Do not silently swap the target word out.",
    "  (R5) Never invent a `distinction` just to fill the field. Skip it",
    "       when there's no real confusable-word issue here.",
    "  (R6) NO RECURSIVE PERFECTIONISM. If the learner's sentence is",
    "       already in the native-acceptable zone, return ok=true and let",
    "       `recommended` equal the original. Do not chase ever-more",
    "       optimal phrasings turn after turn — that breaks the learner's",
    "       flow and makes ok=true unreachable.",
    "  (R7) When ok=true and you have nothing genuinely useful to teach,",
    "       it is OK to skip `diagnosis`, `distinction`, and `ielts` (or",
    "       send them as empty/absent). Silence is better than noise.",
    "",
    "Reply with ONLY a JSON object, no markdown, no commentary:",
    "{",
    '  "ok": true|false,',
    '  "recommended": "<one English sentence>",',
    '  "recommendedAlt": "<optional English sentence>",',
    '  "segments": [{"text":"…"}, {"text":"…","wrong":true,"fix":"…"}],',
    '  "diagnosis": ["<中文一句>", "<中文一句>"],',
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
  const ok = Boolean(p.ok);
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
  // If the model said ok=true but accidentally left wrong segments, scrub them.
  if (ok) {
    for (const s of segments) {
      s.wrong = false;
      s.fix = undefined;
    }
  }
  const diagnosis: string[] = Array.isArray(p.diagnosis)
    ? (p.diagnosis as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
        .slice(0, 3)
    : [];
  const distinction =
    typeof p.distinction === "string" && p.distinction.trim()
      ? p.distinction.trim()
      : undefined;
  const ielts =
    typeof p.ielts === "string" && p.ielts.trim()
      ? p.ielts.trim()
      : undefined;
  return { ok, recommended, recommendedAlt, segments, diagnosis, distinction, ielts };
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
