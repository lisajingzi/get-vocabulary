/**
 * /api/cos/image
 *
 * Standalone image blob storage for note attachments. Kept separate from
 * /api/cos/sync so images never inflate the JSON shards — the shards only
 * store a short `cos:/sync/<syncId>/images/<uuid>.<ext>` reference.
 *
 * Endpoints:
 *   POST ?syncId=<id>&ext=<png|jpg|…>  body=<raw image bytes>
 *     → { key: "cos:/sync/<syncId>/images/<uuid>.<ext>" }
 *
 *   GET  ?syncId=<id>&key=<cos:...>
 *     → streams the image bytes with long-cache headers (keys are
 *       uuid-based so content is effectively immutable).
 *
 * Why POST (not PUT like /sync)? sendBeacon fallback from the client
 * only supports POST, and we may want that later for background uploads.
 *
 * Why not reuse /api/cos/sync? That path assumes JSON bodies and does a
 * JSON.parse validation step. Images are raw bytes.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
// Images can be up to ~2 MB after the client-side downscale; 60 s gives
// mobile networks plenty of headroom.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SECRET_ID = process.env.COS_SECRET_ID ?? "";
const SECRET_KEY = process.env.COS_SECRET_KEY ?? "";
const BUCKET = process.env.COS_BUCKET ?? "";
const REGION = process.env.COS_REGION ?? "ap-guangzhou";

function cosEnabled(): boolean {
  return Boolean(SECRET_ID && SECRET_KEY && BUCKET);
}

function isValidSyncId(id: string): boolean {
  return /^[a-z0-9-]{8,64}$/i.test(id);
}

// Allow the handful of web-safe raster formats the client compressor
// produces. "jpg" is accepted as an alias for "jpeg".
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
function normaliseExt(raw: string): string | null {
  const e = raw.toLowerCase().replace(/^\.+/, "");
  if (!ALLOWED_EXT.has(e)) return null;
  return e === "jpg" ? "jpeg" : e;
}

function mimeFor(ext: string): string {
  if (ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

// Image key format in storage: /sync/<syncId>/images/<uuid>.<ext>
// We also allow the client to pass this back either with or without the
// "cos:" scheme prefix in GET. Returned keys always include the prefix.
const IMAGE_PATH_RE = /^\/sync\/[a-z0-9-]{8,64}\/images\/[a-f0-9-]{8,64}\.[a-z]{2,5}$/i;

function parseKeyToPath(key: string): string | null {
  const stripped = key.startsWith("cos:") ? key.slice(4) : key;
  if (!stripped.startsWith("/")) return null;
  if (!IMAGE_PATH_RE.test(stripped)) return null;
  return stripped;
}

/**
 * Cross-check that the caller's syncId actually matches the one baked
 * into the image path. Prevents a client with syncId A from reading /
 * overwriting images belonging to syncId B.
 */
function pathMatchesSyncId(path: string, syncId: string): boolean {
  return path.startsWith(`/sync/${syncId}/images/`);
}

// ---------------------------------------------------------------------------
// COS v5 simple-request signing (same algorithm as /api/cos/sync)
// ---------------------------------------------------------------------------
function cosSign(method: string, path: string): string {
  const now = Math.floor(Date.now() / 1000);
  const expire = now + 900;
  const keyTime = `${now};${expire}`;

  const signKey = crypto
    .createHmac("sha1", SECRET_KEY)
    .update(keyTime)
    .digest("hex");

  const httpString = `${method.toLowerCase()}\n${path}\n\n\n`;
  const sha1Hash = crypto.createHash("sha1").update(httpString).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${sha1Hash}\n`;
  const signature = crypto
    .createHmac("sha1", signKey)
    .update(stringToSign)
    .digest("hex");

  return (
    `q-sign-algorithm=sha1` +
    `&q-ak=${SECRET_ID}` +
    `&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=` +
    `&q-url-param-list=` +
    `&q-signature=${signature}`
  );
}

function cosUrl(path: string): string {
  return `https://${BUCKET}.cos.${REGION}.myqcloud.com${path}`;
}

// ---------------------------------------------------------------------------
// POST — upload bytes, return cos: key
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const syncId = req.nextUrl.searchParams.get("syncId") ?? "";
  const extRaw = req.nextUrl.searchParams.get("ext") ?? "jpeg";
  if (!syncId || !isValidSyncId(syncId)) {
    return NextResponse.json({ error: "invalid syncId" }, { status: 400 });
  }
  const ext = normaliseExt(extRaw);
  if (!ext) {
    return NextResponse.json({ error: "invalid ext" }, { status: 400 });
  }

  let buf: ArrayBuffer;
  try {
    buf = await req.arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "failed to read body", detail: msg },
      { status: 400 },
    );
  }
  // Reject empty bodies — almost certainly a client-side bug.
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }
  // Soft cap at ~8 MB so a runaway client can't eat Vercel memory. The
  // client-side compressor targets ~150 KB per image.
  if (buf.byteLength > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "image too large" }, { status: 413 });
  }

  // Vercel's Node 18+/Edge runtimes all expose global Web Crypto,
  // so randomUUID() is always available here.
  const uuid = crypto.randomUUID();
  const path = `/sync/${syncId}/images/${uuid}.${ext}`;
  const auth = cosSign("put", path);
  const url = cosUrl(path);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": mimeFor(ext),
        "Content-Length": String(buf.byteLength),
      },
      // Node fetch accepts ArrayBuffer directly.
      body: buf,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/image POST] network error", msg);
    return NextResponse.json(
      { error: "upstream fetch failed", detail: msg },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error(
      "[cos/image POST] cos error",
      upstream.status,
      errText.slice(0, 200),
    );
    return NextResponse.json(
      {
        error: `COS error ${upstream.status}`,
        detail: errText.slice(0, 500),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    key: `cos:${path}`,
    bytes: buf.byteLength,
  });
}

// ---------------------------------------------------------------------------
// GET — stream image bytes by key
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const syncId = req.nextUrl.searchParams.get("syncId") ?? "";
  const rawKey = req.nextUrl.searchParams.get("key") ?? "";
  if (!syncId || !isValidSyncId(syncId)) {
    return NextResponse.json({ error: "invalid syncId" }, { status: 400 });
  }
  const path = parseKeyToPath(rawKey);
  if (!path) {
    return NextResponse.json({ error: "invalid key" }, { status: 400 });
  }
  if (!pathMatchesSyncId(path, syncId)) {
    return NextResponse.json({ error: "syncId mismatch" }, { status: 403 });
  }

  const auth = cosSign("get", path);
  const url = cosUrl(path);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Authorization: auth },
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/image GET] network error", msg);
    return NextResponse.json(
      { error: "upstream fetch failed", detail: msg },
      { status: 502 },
    );
  }

  if (upstream.status === 404) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error(
      "[cos/image GET] cos error",
      upstream.status,
      errText.slice(0, 200),
    );
    return NextResponse.json(
      { error: `COS error ${upstream.status}` },
      { status: 502 },
    );
  }

  // Stream upstream body through. Image keys are uuid-based, so once
  // uploaded the bytes never change — safe to cache aggressively.
  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") || "application/octet-stream",
  );
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(upstream.body, { status: 200, headers });
}
