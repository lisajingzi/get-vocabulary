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
  const auth = cosSign("get", path);
  const url = cosUrl(path);

  const res = await fetch(url, {
    headers: { Authorization: auth },
  });

  if (res.status === 404) {
    return NextResponse.json(null, { status: 200 }); // no remote snapshot yet
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: `COS error ${res.status}` },
      { status: 502 },
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}

export async function PUT(req: NextRequest) {
  if (!cosEnabled()) {
    return NextResponse.json({ error: "COS not configured" }, { status: 503 });
  }

  const syncId = req.nextUrl.searchParams.get("syncId");
  if (!syncId || !/^[a-z0-9-]{8,64}$/i.test(syncId)) {
    return NextResponse.json({ error: "invalid syncId" }, { status: 400 });
  }

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
    const errText = await res.text();
    console.error("[cos/sync PUT]", res.status, errText);
    return NextResponse.json(
      { error: `COS error ${res.status}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
