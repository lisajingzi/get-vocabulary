/**
 * POST /api/tts
 *
 * Returns an MP3 stream synthesised by Microsoft Edge's Neural TTS backend.
 * This is the same endpoint the "read aloud" feature in the Edge browser
 * hits — no API key, no cost, and voices are Neural (near-human).
 *
 * Protocol reference: rany2/edge-tts (Python) — the de-facto client that
 * every open-source port copies. We mirror its exact framing here because
 * the Bing endpoint is fussy about header casing / line endings and quietly
 * closes connections that don't match.
 *
 *   1. Connect to `wss://speech.platform.bing.com/consumer/speech/synthesize/
 *      readaloud/edge/v1?TrustedClientToken=<TOKEN>` with an Edge-like UA.
 *   2. Send a `speech.config` JSON blob (audio format, per-request X-RequestId).
 *   3. Send an SSML `<speak>` blob (same X-RequestId).
 *   4. Server streams back binary chunks (MP3 audio) framed with headers
 *      terminated by `\r\n\r\n`; text messages carry `Path:turn.start`,
 *      `Path:response`, and finally `Path:turn.end` — that's our "done".
 *
 * All this is documented across the various open-source `edge-tts` clones.
 * We inline it to avoid adding a native/heavy dependency.
 *
 * Request body: { text: string; voice?: string; rate?: string; pitch?: string }
 * Response:     audio/mpeg body (MP3), Cache-Control: public, max-age=31536000
 *
 * On failure returns HTTP 502 with a JSON `{ error }` body so the client can
 * transparently fall back to Web Speech.
 */

import { NextResponse } from "next/server";
import { WebSocket } from "ws";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

// Public constant baked into the Edge browser. NOT a secret.
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

// Windows-epoch offset in seconds (between 1601-01-01 and 1970-01-01).
const WIN_EPOCH = 11644473600;
// Nanoseconds per second, in the exact form rany2/edge-tts uses.
const S_TO_NS = 1e9;

/**
 * Byte-for-byte port of rany2/edge-tts `DRM.generate_sec_ms_gec()`.
 *
 * 1. current unix timestamp (seconds, float)
 * 2. + Windows epoch offset  → seconds since 1601-01-01
 * 3. round down to nearest 5-minute boundary
 * 4. multiply by 1e9/100 = 1e7  → 100-ns ticks (Windows FILETIME)
 * 5. concatenate with the trusted client token, SHA-256, uppercase hex
 *
 * Microsoft rolled this out in late-2024; requests without a valid
 * signature get a 403.
 */
function generateSecMsGec(): string {
  let ticks = Date.now() / 1000; // float seconds
  ticks += WIN_EPOCH;
  ticks -= ticks % 300; // round down to 5 minutes
  ticks *= S_TO_NS / 100; // → FILETIME 100-ns intervals

  // Python's `f"{ticks:.0f}"` rounds half-to-even; because we always land on
  // a 5-minute boundary the value is exactly representable, so toFixed(0)
  // produces the same digits.
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(strToHash, "ascii").digest("hex").toUpperCase();
}

const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const CHROMIUM_MAJOR = "143";

interface RequestBody {
  text: string;
  voice?: string;
  rate?: string;
  pitch?: string;
}

const DEFAULT_VOICE = "en-US-JennyNeural";
const DEFAULT_RATE = "+0%";
const DEFAULT_PITCH = "+0Hz";

function escapeSSML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSSML(text: string, voice: string, rate: string, pitch: string): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody rate='${rate}' pitch='${pitch}'>${escapeSSML(text)}</prosody>` +
    `</voice></speak>`
  );
}

/** rany2/edge-tts uses this format: "Wed Oct 05 2022 20:40:29 GMT+0000 (Coordinated Universal Time)". */
function edgeDateString(): string {
  return new Date().toString() + "Z";
}

function makeRequestId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract the MP3 payload from a single binary WS frame.
 * Frame layout: 2-byte big-endian header length + ASCII headers +
 * `\r\n\r\n` + audio bytes. Returns null if this frame carries no audio.
 */
function extractAudioChunk(buf: Buffer): Buffer | null {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  if (headerLen <= 0 || headerLen + 2 > buf.length) return null;
  const headers = buf.subarray(2, 2 + headerLen).toString("utf8");
  // Only frames with `Path:audio` carry MP3 bytes. Metadata frames like
  // `Path:audio.metadata` or `Path:response` have empty payloads.
  const pathMatch = headers.match(/Path:\s*(\S+)/i);
  if (!pathMatch || pathMatch[1] !== "audio") return null;
  return buf.subarray(2 + headerLen);
}

function isTurnEnd(text: string): boolean {
  return /Path:\s*turn\.end/i.test(text);
}

function isTurnStart(text: string): boolean {
  return /Path:\s*turn\.start/i.test(text);
}

async function synthesize(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const requestId = makeRequestId();
    // Rebuild the URL each call so ConnectionId + Sec-MS-GEC stay fresh.
    // Parameter order must match rany2/edge-tts exactly — the anti-abuse
    // gate is order-sensitive.
    const connectionId = makeRequestId();
    const secMsGec = generateSecMsGec();
    const url =
      `${WSS_URL}` +
      `&ConnectionId=${connectionId}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const ws = new WebSocket(url, {
      perMessageDeflate: true,
      headers: {
        "User-Agent":
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
          `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    // Surface Bing's real HTTP response (403/429/etc.) instead of the opaque
    // "Unexpected server response: 403" default — the response body often
    // contains a hint (e.g. quota exceeded, invalid signature).
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 500) body += chunk;
      });
      res.on("end", () => {
        console.error(
          `[tts] handshake rejected (req=${requestId}, status=${res.statusCode} ${res.statusMessage}): ${body.slice(0, 500)}`,
        );
      });
    });

    const chunks: Buffer[] = [];
    let settled = false;
    let gotTurnStart = false;

    const finish = (err: Error | null, out?: Buffer) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      if (err) {
        console.error(`[tts] synthesize failed (req=${requestId}):`, err.message);
        reject(err);
      } else {
        console.log(
          `[tts] synthesize ok (req=${requestId}, voice=${voice}, ` +
            `chars=${text.length}, mp3=${out?.length ?? 0}B, chunks=${chunks.length})`,
        );
        resolve(out ?? Buffer.alloc(0));
      }
    };

    // 8s is generous for short sentences (typical response is 0.5–2s).
    // Cross-border WebSocket to Bing is flaky — better to fail fast and let
    // the outer POST handler retry on a fresh connection than sit for 20s.
    const timer = setTimeout(
      () => finish(new Error("edge-tts timeout after 8s")),
      8_000,
    );

    ws.on("open", () => {
      // rany2/edge-tts sends config first with its own X-RequestId, then SSML
      // with the same request id. Both messages use \r\n line endings.
      const configMsg =
        `X-Timestamp:${edgeDateString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{` +
        `"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
        `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      ws.send(configMsg);

      const ssml = buildSSML(text, voice, rate, pitch);
      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${edgeDateString()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        const audio = extractAudioChunk(buf);
        if (audio && audio.length > 0) chunks.push(audio);
      } else {
        // Text metadata frame. We only care about turn.start / turn.end.
        const msg = data.toString();
        if (isTurnStart(msg)) {
          gotTurnStart = true;
        } else if (isTurnEnd(msg)) {
          clearTimeout(timer);
          finish(null, Buffer.concat(chunks));
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      if (settled) return;
      // Some Bing nodes close before sending turn.end when the response fits
      // in a single burst. Accept the audio if we at least saw turn.start
      // and got some bytes.
      if (gotTurnStart && chunks.length > 0) {
        finish(null, Buffer.concat(chunks));
      } else {
        const reasonStr = reason?.toString?.() || "(no reason)";
        finish(
          new Error(
            `edge-tts closed prematurely (code=${code}, reason=${reasonStr}, chunks=${chunks.length})`,
          ),
        );
      }
    });
  });
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "text too long" }, { status: 413 });
  }

  const voice = body.voice || DEFAULT_VOICE;
  const rate = body.rate || DEFAULT_RATE;
  const pitch = body.pitch || DEFAULT_PITCH;

  console.log(
    `[tts] POST /api/tts voice=${voice} chars=${text.length} preview="${text.slice(0, 40)}..."`,
  );

  // Retry once on the server side. edge-tts drops connections randomly
  // (403 handshakes, mid-stream closes, timeouts) but a fresh WS with a
  // new ConnectionId + Sec-MS-GEC almost always succeeds on the second try.
  // Two attempts × 8s timeout = 16s worst case, still under the Vercel
  // maxDuration=30s budget.
  const MAX_ATTEMPTS = 2;
  let mp3: Buffer | null = null;
  let lastErr: string = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      mp3 = await synthesize(text, voice, rate, pitch);
      if (mp3.length > 0) break;
      lastErr = "empty audio from edge-tts";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[tts] attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastErr}), retrying...`,
      );
    }
  }

  if (!mp3 || mp3.length === 0) {
    return NextResponse.json(
      { error: lastErr || "edge-tts failed" },
      { status: 502 },
    );
  }

  try {
    // Copy into a fresh ArrayBuffer so DOM's BlobPart typing accepts it
    // (Buffer's `.buffer` is typed as ArrayBufferLike which trips TS).
    const ab = new ArrayBuffer(mp3.length);
    new Uint8Array(ab).set(mp3);
    const blob = new Blob([ab], { type: "audio/mpeg" });
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(mp3.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    // Only reachable if Blob/Response construction throws — extremely rare.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
