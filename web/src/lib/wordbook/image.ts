/**
 * Image attachment helpers for note storage.
 *
 * Background: note `image` fields used to be inlined base64 data URLs,
 * which inflated the `wordNotes` / `notebookNotes` / `stringNotes` shards
 * past the point where the cloud-sync PUT reliably completed under 20 s.
 * We now store each image as a standalone COS object and only persist a
 * short reference string of the form:
 *
 *   "cos:/sync/<syncId>/images/<uuid>.<ext>"
 *
 * Backwards compat: existing notes still carry base64 data URLs
 * ("data:image/...") and must continue to render. The resolver below
 * handles both schemes transparently, so UI components don't need to
 * care which flavour they're looking at.
 *
 * Why not migrate the historical data URLs? Because the current shard
 * size is already acceptable once new images stop being inlined — the
 * historical ones were already tolerated. We can add a batch migration
 * later if the shards ever grow uncomfortably again.
 */

import { getSyncId } from "@/lib/sync/cloud";

/**
 * Downscale a user-picked image and return a Blob + inferred extension.
 * Matches the previous `fileToCompressedDataUrl` pipeline (<=1200 px on
 * the longer edge, JPEG q=0.85). We return a Blob instead of a data URL
 * so the upload path streams real bytes to COS without the ~33% base64
 * bloat.
 */
export async function fileToCompressedBlob(
  file: File,
): Promise<{ blob: Blob; ext: "jpeg" }> {
  if (!file.type.startsWith("image/")) {
    throw new Error("仅支持图片文件");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = objectUrl;
    });
    const MAX = 1200;
    let { width, height } = img;
    if (width > MAX || height > MAX) {
      const ratio = Math.min(MAX / width, MAX / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("canvas.toBlob returned null");
    return { blob, ext: "jpeg" };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Upload a File → returns a `cos:...` key suitable for stashing in a
 * note's `image` field. Throws on network / server failure so callers
 * can surface the error in the UI rather than silently saving a note
 * without its attachment.
 */
export async function uploadImageFile(file: File): Promise<string> {
  const syncId = getSyncId();
  if (!syncId) {
    throw new Error("尚未初始化同步 ID，无法上传图片");
  }
  const { blob, ext } = await fileToCompressedBlob(file);
  const res = await fetch(
    `/api/cos/image?syncId=${encodeURIComponent(syncId)}&ext=${ext}`,
    {
      method: "POST",
      headers: { "Content-Type": blob.type || `image/${ext}` },
      body: blob,
    },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(`图片上传失败：${detail}`);
  }
  const body = (await res.json()) as { key?: string };
  if (!body?.key || !body.key.startsWith("cos:")) {
    throw new Error("图片上传返回缺少 key");
  }
  return body.key;
}

/**
 * Turn whatever is stored in a note's `image` field into something an
 * <img src=…> can render.
 *
 *   - undefined / empty       → undefined (caller should not render)
 *   - "data:image/..."        → returned as-is (legacy inline base64)
 *   - "cos:/sync/..."         → rewritten to the /api/cos/image?… URL
 *     scoped to the current syncId. Returns undefined if no syncId is
 *     available yet (SSR / very early boot), so the img tag is omitted
 *     instead of being broken.
 *   - anything else           → returned as-is (graceful fallback for
 *     unknown future schemes; the browser will decide whether to render)
 */
export function resolveImageSrc(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("data:")) return value;
  if (value.startsWith("cos:")) {
    const syncId = getSyncId();
    if (!syncId) return undefined;
    return `/api/cos/image?syncId=${encodeURIComponent(
      syncId,
    )}&key=${encodeURIComponent(value)}`;
  }
  return value;
}
