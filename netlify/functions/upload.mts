import type { Config, Context } from "@netlify/functions";
import { mediaStore, newId } from "../lib/store.mjs";
import { gateWrite } from "../lib/auth.mjs";

// Chunked upload. Netlify caps a function request body at roughly 6MB, so a
// reel arrives in pieces: init, then N chunks, then finalise, which stitches
// them into one blob and drops the parts.
//
//   POST /api/upload?action=init      { filename, size, contentType } -> { uploadId }
//   POST /api/upload?action=chunk     ?uploadId=&index=   body: raw bytes
//   POST /api/upload?action=finalize  { uploadId, chunks } -> { mediaId, url, bytes }

const MAX_BYTES = 400 * 1024 * 1024; // reels are far smaller; this is a sanity bound

export default async (req: Request, _context: Context) => {
  const denied = gateWrite(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const store = mediaStore();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  try {
    if (action === "init") {
      const { filename, size, contentType } = await req.json();
      if (typeof size === "number" && size > MAX_BYTES) {
        return json({ error: `file too large (${size} bytes, limit ${MAX_BYTES})` }, 413);
      }
      const uploadId = newId();
      await store.setJSON(`upload/${uploadId}/meta`, {
        filename: filename || "video.mp4",
        contentType: contentType || "video/mp4",
        size: size ?? null,
        startedAt: new Date().toISOString(),
      });
      return json({ uploadId });
    }

    if (action === "chunk") {
      const uploadId = url.searchParams.get("uploadId");
      const index = Number(url.searchParams.get("index"));
      if (!uploadId || !Number.isInteger(index) || index < 0) {
        return json({ error: "uploadId and a non-negative integer index are required" }, 400);
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.byteLength) return json({ error: "empty chunk" }, 400);
      await store.set(`upload/${uploadId}/part/${String(index).padStart(5, "0")}`, bytes);
      return json({ ok: true, index, bytes: bytes.byteLength });
    }

    if (action === "finalize") {
      const { uploadId, chunks } = await req.json();
      if (!uploadId || !Number.isInteger(chunks) || chunks < 1) {
        return json({ error: "uploadId and chunk count are required" }, 400);
      }
      const meta = await store.get(`upload/${uploadId}/meta`, { type: "json" });
      if (!meta) return json({ error: "unknown uploadId" }, 404);

      // Read parts in order and concatenate. Every part must be present:
      // a silently short video would be rejected by Instagram much later,
      // with a far less obvious error.
      const parts: Uint8Array[] = [];
      let total = 0;
      for (let i = 0; i < chunks; i++) {
        const key = `upload/${uploadId}/part/${String(i).padStart(5, "0")}`;
        const buf = await store.get(key, { type: "arrayBuffer" });
        if (!buf) return json({ error: `missing chunk ${i} of ${chunks}` }, 400);
        const view = new Uint8Array(buf);
        parts.push(view);
        total += view.byteLength;
      }
      if (meta.size && total !== meta.size) {
        return json(
          { error: `assembled ${total} bytes but expected ${meta.size}; upload incomplete` },
          400
        );
      }

      const joined = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        joined.set(p, offset);
        offset += p.byteLength;
      }

      const mediaId = newId();
      await store.set(mediaId, joined, {
        metadata: { filename: meta.filename, contentType: meta.contentType, bytes: total },
      });

      for (let i = 0; i < chunks; i++) {
        await store.delete(`upload/${uploadId}/part/${String(i).padStart(5, "0")}`);
      }
      await store.delete(`upload/${uploadId}/meta`);

      return json({
        mediaId,
        bytes: total,
        filename: meta.filename,
        url: `${url.origin}/media/${mediaId}`,
      });
    }

    return json({ error: "action must be init, chunk or finalize" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
};

export const config: Config = {
  path: "/api/upload",
};
