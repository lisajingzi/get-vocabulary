/**
 * POST /api/ai/correct
 *
 * Grades a learner's English sentence for use of a target word, returns:
 *   - whether the sentence is acceptable (uses the target word correctly,
 *     in the requested sense, and is grammatical),
 *   - a "diff" of corrections (segments to keep + segments to mark wrong +
 *     replacement text), so the UI can render the original with red strike-
 *     throughs over the broken parts and the fix in-line.
 *
 * Request body:
 *   { lemma, sense?, sentence }
 *
 * Response body:
 *   {
 *     ok: boolean,                 // true == accepted as-is, no edits needed
 *     reason: string,              // one Chinese sentence explaining the verdict
 *     segments: Array<{            // ordered, concatenating .text reproduces original
 *       text: string,              // the original chunk
 *       wrong?: boolean,           // true == this chunk is incorrect
 *       fix?: string               // the corrected replacement (only set when wrong)
 *     }>,
 *     provider: "deepseek" | "mock"
 *   }
 *
 * Falls back to a deterministic mock when DEEPSEEK_API_KEY is unset, so the
 * UI is testable end-to-end before the real key lands.
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
  reason: string;
  segments: Segment[];
  provider: "deepseek" | "mock";
}

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

function buildPrompt(lemma: string, sentence: string, sense?: SenseHint) {
  const senseLine = sense?.def
    ? `Target sense: "${sense.def}"${sense.chn ? ` (中文: ${sense.chn})` : ""}.`
    : "Target sense: most common.";
  return [
    "You are a strict but kind English writing tutor for a Chinese B2 learner.",
    `Target word: "${lemma}". ${senseLine}`,
    `Learner's sentence: """${sentence}"""`,
    "Your job:",
    "1) Decide if the sentence (a) uses the target word in the requested sense,",
    "   (b) is grammatically natural English. If both are true, set ok=true.",
    "2) If anything is wrong, produce a segment list that, when concatenated by .text,",
    "   reproduces the original sentence VERBATIM. Mark the broken segments with",
    "   {wrong:true, fix:'<the corrected words>'}. Keep correct stretches as plain",
    "   {text:'…'} segments.",
    "3) Provide one short Chinese sentence in `reason` explaining the verdict.",
    "Reply with ONLY a JSON object, no markdown:",
    '{ "ok": true|false, "reason": "<中文>", "segments": [ {"text":"…"}, {"text":"…","wrong":true,"fix":"…"} ] }',
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
 * Mock heuristic correction:
 *   - Accept if the lemma (or a simple inflection) appears as a whole word.
 *   - Otherwise mark the whole sentence wrong and suggest a templated fix.
 *
 * This isn't trying to be smart — it just exercises every code path on the
 * UI side so the real DeepSeek integration plugs in cleanly later.
 */
function mockCorrect(
  lemma: string,
  sentence: string,
  sense?: SenseHint,
): ResponseBody {
  const re = new RegExp(
    `\\b${lemma.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(s|es|ed|ing|d)?\\b`,
    "i",
  );
  if (re.test(sentence) && sentence.trim().length > 5) {
    return {
      ok: true,
      reason: `用法看起来没问题，符合「${sense?.chn ?? lemma}」的释义。`,
      segments: [{ text: sentence }],
      provider: "mock",
    };
  }
  // Try to point at the missing-word slot.
  return {
    ok: false,
    reason: `句子里没有出现 "${lemma}"，或用法不太自然，建议改写。`,
    segments: [
      { text: sentence, wrong: true, fix: `She decided to ${lemma} the project.` },
    ],
    provider: "mock",
  };
}

async function callDeepseek(
  lemma: string,
  sentence: string,
  sense: SenseHint | undefined,
  apiKey: string,
): Promise<ResponseBody> {
  const prompt = buildPrompt(lemma, sentence, sense);
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 360,
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
  const parsed = JSON.parse(jsonStr) as Partial<ResponseBody>;
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments
        .map((s) => ({
          text: String((s as Segment).text ?? ""),
          wrong: Boolean((s as Segment).wrong),
          fix:
            (s as Segment).fix !== undefined
              ? String((s as Segment).fix)
              : undefined,
        }))
        .filter((s) => s.text.length > 0)
    : [{ text: sentence }];
  return {
    ok: Boolean(parsed.ok),
    reason: String(parsed.reason ?? ""),
    segments,
    provider: "deepseek",
  };
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
    return NextResponse.json(mockCorrect(lemma, sentence, body.sense));
  }
  try {
    return NextResponse.json(
      await callDeepseek(lemma, sentence, body.sense, apiKey),
    );
  } catch (err) {
    console.error("[ai/correct] deepseek call failed:", err);
    return NextResponse.json({ ...mockCorrect(lemma, sentence, body.sense), provider: "mock" });
  }
}
