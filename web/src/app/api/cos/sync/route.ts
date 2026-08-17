/**
 * /api/cos/sync
 *
 * Thin server-side proxy for Tencent COS reads/writes.
 * The COS SecretId/SecretKey are server-only env vars — never sent to the
 * browser. The client only knows its syncId (a UUID stored in localStorage).
 *
 * GET  ?syncId=<uuid>          → download the snapshot JSON for that id
 * PUT  ?syncId=<uuid>  body=JSON  → upload / overwrite the snapshot
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// COS credentials (server-only)
// ---------------------------------------------------------------------------
const SECRET_ID = process.env.COS_SECRET_ID ?? "";
const SECRET_KEY = process.env.COS_SECRET_KEY ?? "";
const BUCKET = process.env.COS_BUCKET ?? ""; // e.g. "get-sync-1234567890"
const REGION = process.env.COS_REGION ?? "ap-guangzhou";

function cosEnabled() {
  return Boolean(SECRET_ID && SECRET_KEY && BUCKET);
}

// ---------------------------------------------------------------------------
// COS request signing (HMAC-SHA1, v5 simple request)
// ---------------------------------------------------------------------------
function cosSign(
  method: string,
  path: string, // e.g. "/sync/<id>.json"
  query: Record<string, string> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const expire = now + 900; // 15 min
  const keyTime = `${now};${expire}`;

  // Step 1: SignKey
  const signKey = crypto
    .createHmac("sha1", SECRET_KEY)
    .update(keyTime)
    .digest("hex");

  // Step 2: HttpString
  const sortedParams = Object.keys(query)
    .sort()
    .map((k) => `${k.toLowerCase()}=${encodeURIComponent(query[k])}`)
    .join("&");
  const httpString = `${method.toLowerCase()}\n${path}\n${sortedParams}\n\n`;

  // Step 3: StringToSign
  const sha1Hash = crypto
    .createHash("sha1")
    .update(httpString)
    .digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${sha1Hash}\n`;

  // Step 4: Signature
  const signature = crypto
    .createHmac("sha1", signKey)
    .update(stringToSign)
    .digest("hex");

  const q = Object.keys(query)
    .sort()
    .map((k) => k.toLowerCase())
    .join(";");

  return (
    `q-sign-algorithm=sha1` +
    `&q-ak=${SECRET_ID}` +
    `&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=` +
    `&q-url-param-list=${q}` +
    `&q-signature=${signature}`
  );
}

function cosUrl(path: string) {
  return `https://${BUCKET}.cos.${REGION}.myqcloud.com${path}`;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const syncId = req.nextUrl.searchParams.get("syncId");
  if (!syncId || !/^[a-z0-9-]{8,64}$/i.test(syncId)) {
    return NextResponse.json({ error: "invalid syncId" }, { status: 400 });
  }

  const path = `/sync/${syncId}.json`;

  try {
    const auth = cosSign("get", path);
    const url = cosUrl(path);

    const res = await fetch(url, {
      headers: { Authorization: auth },
    });

    if (res.status === 404) {
      return NextResponse.json(null, { status: 200 }); // no remote snapshot yet
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[cos/sync GET] cos error", res.status, errText);
      return NextResponse.json(
        { error: `COS error ${res.status}`, detail: errText.slice(0, 500) },
        { status: 502 },
      );
    }

    // Read as text first so we can log the raw body if JSON.parse fails.
    // Previously `await res.json()` throwing would crash the handler and
    // Next.js returned a plain 500 with no body, making it impossible to
    // tell whether COS was down, response was truncated, etc.
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      console.error(
        "[cos/sync GET] failed to parse COS response as JSON",
        "len=" + text.length,
        "head=" + text.slice(0, 200),
        e,
      );
      return NextResponse.json(
        {
          error: "COS returned non-JSON response",
          length: text.length,
          head: text.slice(0, 200),
        },
        { status: 502 },
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/sync GET] handler crashed", msg, e);
    return NextResponse.json(
      { error: "handler crashed", detail: msg },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const syncId = req.nextUrl.searchParams.get("syncId");
  if (!syncId || !/^[a-z0-9-]{8,64}$/i.test(syncId)) {
    return NextResponse.json({ error: "invalid syncId" }, { status: 400 });
  }

  try {
    const body = await req.text();
    // Sanity-check: must be valid JSON
    try {
      JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
    }

    const path = `/sync/${syncId}.json`;
    const auth = cosSign("put", path);
    const url = cosUrl(path);

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[cos/sync PUT] cos error", res.status, errText);
      return NextResponse.json(
        { error: `COS error ${res.status}`, detail: errText.slice(0, 500) },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cos/sync PUT] handler crashed", msg, e);
    return NextResponse.json(
      { error: "handler crashed", detail: msg },
      { status: 500 },
    );
  }
}
