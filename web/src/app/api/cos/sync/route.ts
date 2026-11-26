/**
 * /api/cos/sync
 *
 * Thin server-side proxy for Tencent COS reads/writes. COS credentials are
 * server-only env vars; the browser only ever knows its syncId.
 *
 * Storage layout in COS (per syncId):
 *   /sync/<syncId>/<shard>.json    — one file per data shard
 *   /sync/<syncId>.json            — legacy monolithic snapshot (read-only,
 *                                    kept for one-time migration only)
 *
 * Endpoints:
 *   GET  ?syncId=<id>&shard=<name>              → download that shard's JSON
 *   GET  ?syncId=<id>&shard=__legacy__          → download legacy monolithic
 *                                                  snapshot (migration only)
 *   PUT  ?syncId=<id>&shard=<name>  body=JSON   → upload/overwrite that shard
 *
 * Design notes:
 *   - Response body from COS is streamed straight through to the browser
 *     (no JSON.parse / re-serialise on the Vercel function). This keeps
 *     serverless memory flat regardless of shard size.
 *   - We pass Accept-Encoding through so gzip stays end-to-end.
 *   - maxDuration=30 gives slow mobile networks headroom.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// COS credentials (server-only)
// ---------------------------------------------------------------------------
const SECRET_ID = process.env.COS_SECRET_ID ?? "";
const SECRET_KEY = process.env.COS_SECRET_KEY ?? "";
const BUCKET = process.env.COS_BUCKET ?? "";
const REGION = process.env.COS_REGION ?? "ap-guangzhou";

function cosEnabled() {
  return Boolean(SECRET_ID && SECRET_KEY && BUCKET);
}

// ---------------------------------------------------------------------------
// Shard whitelist
// ---------------------------------------------------------------------------
// One entry per top-level data store the client owns. Adding a new store
// only requires appending to this list on both server and client.
const SHARDS = new Set([
  "wordbook",
  "wordNotes",
  "notebook",
  "notebookNotes",
  "punches",
  "preferences",
  "reviewLog",
  "dailySnapshot",
  "stringNotes",
  "reviewSessions",
  "groups",
]);
// Special marker for the pre-shard monolithic snapshot; supported on GET
// only, purely for one-time client-side migration.
const LEGACY_SHARD = "__legacy__";

function isValidSyncId(id: string): boolean {
  return /^[a-z0-9-]{8,64}$/i.test(id);
}

function isValidShard(s: string): boolean {
  return s === LEGACY_SHARD || SHARDS.has(s);
}

function cosObjectPath(syncId: string, shard: string): string {
  if (shard === LEGACY_SHARD) return `/sync/${syncId}.json`;
  return `/sync/${syncId}/${shard}.json`;
}

// ---------------------------------------------------------------------------
// COS request signing (HMAC-SHA1, v5 simple request)
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
// Request validation
// ---------------------------------------------------------------------------
function parseParams(req: NextRequest):
  | { ok: true; syncId: string; shard: string }
  | { ok: false; response: NextResponse } {
  const syncId = req.nextUrl.searchParams.get("syncId") ?? "";
  const shard = req.nextUrl.searchParams.get("shard") ?? "";

  if (!syncId || !isValidSyncId(syncId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid syncId" },
        { status: 400 },
      ),
    };
  }
  if (!shard || !isValidShard(shard)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid or missing shard" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, syncId, shard };
}

// ---------------------------------------------------------------------------
// GET — download a shard (streamed)
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const parsed = parseParams(req);
  if (!parsed.ok) return parsed.response;
  const { syncId, shard } = parsed;

  const path = cosObjectPath(syncId, shard);
  const auth = cosSign("get", path);
  const url = cosUrl(path);

  // Forward the browser's Accept-Encoding so gzip stays end-to-end.
  const acceptEncoding =
    req.headers.get("accept-encoding") || "gzip, deflate, br";

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        Authorization: auth,
        "Accept-Encoding": acceptEncoding,
      },
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/sync GET] network error", shard, msg);
    return NextResponse.json(
      { error: "upstream fetch failed", detail: msg },
      { status: 502 },
    );
  }

  if (upstream.status === 404) {
    // No shard yet — signal "empty" so client treats it as "nothing on cloud".
    return NextResponse.json(null, { status: 200 });
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error(
      "[cos/sync GET] cos error",
      shard,
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

  // Stream the body straight through. Preserve Content-Type/Encoding/Length
  // so gzip stays intact on the wire.
  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") || "application/json; charset=utf-8",
  );
  const enc = upstream.headers.get("content-encoding");
  if (enc) headers.set("Content-Encoding", enc);
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// PUT — upload a shard
// ---------------------------------------------------------------------------
export async function PUT(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const parsed = parseParams(req);
  if (!parsed.ok) return parsed.response;
  const { syncId, shard } = parsed;

  if (shard === LEGACY_SHARD) {
    return NextResponse.json(
      { error: "legacy shard is read-only" },
      { status: 400 },
    );
  }

  let body: string;
  try {
    body = await req.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "failed to read body", detail: msg },
      { status: 400 },
    );
  }

  // Sanity-check: must parse as JSON. Shape is the client's responsibility.
  try {
    JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const path = cosObjectPath(syncId, shard);
  const auth = cosSign("put", path);
  const url = cosUrl(path);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/sync PUT] network error", shard, msg);
    return NextResponse.json(
      { error: "upstream fetch failed", detail: msg },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error(
      "[cos/sync PUT] cos error",
      shard,
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

  return NextResponse.json({ ok: true, shard, bytes: body.length });
}
