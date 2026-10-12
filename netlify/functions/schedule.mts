import type { Config, Context } from "@netlify/functions";
import { readSchedule, mutateSchedule, makeItem, newId, mediaStore } from "../lib/store.mjs";
import { gateRead, gateWrite } from "../lib/auth.mjs";

//   GET    /api/schedule          list everything
//   POST   /api/schedule          create   { mediaId, filename, caption, title, scheduledAt, targets }
//   PATCH  /api/schedule?id=      edit     { caption, title, scheduledAt, targets }
//   DELETE /api/schedule?id=      cancel (keeps the record; the uploaded file stays in storage)
//   DELETE /api/schedule?id=&purge=1   remove the record

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (req.method === "GET") {
    const denied = gateRead(req);
    if (denied) return denied;
    return json({ items: await readSchedule() });
  }

  const denied = gateWrite(req);
  if (denied) return denied;

  try {
    if (req.method === "POST") {
      const body = await req.json();
      if (!body.mediaId) return json({ error: "mediaId is required" }, 400);
      if (!body.scheduledAt || Number.isNaN(Date.parse(body.scheduledAt))) {
        return json({ error: "scheduledAt must be an ISO timestamp" }, 400);
      }
      if (!body.targets?.instagram && !body.targets?.youtube) {
        return json({ error: "pick at least one platform" }, 400);
      }
      // A missing file would only surface at publish time, hours later.
      const meta = await mediaStore().getMetadata(body.mediaId);
      if (!meta) return json({ error: "mediaId does not exist; upload the video first" }, 400);

      const item = makeItem({
        id: newId(8),
        mediaId: body.mediaId,
        filename: body.filename,
        caption: body.caption,
        title: body.title,
        scheduledAt: new Date(body.scheduledAt).toISOString(),
        targets: body.targets,
        sizeBytes: (meta.metadata?.bytes as number) ?? null,
        contentType: (meta.metadata?.contentType as string) ?? "video/mp4",
      });
      await mutateSchedule((items) => [...items, item]);
      return json({ item });
    }

    if (req.method === "PATCH") {
      if (!id) return json({ error: "id is required" }, 400);
      const body = await req.json();
      if (body.scheduledAt && Number.isNaN(Date.parse(body.scheduledAt))) {
        return json({ error: "scheduledAt must be an ISO timestamp" }, 400);
      }
      // Only these are editable. Spreading the request body wholesale would let
      // a caller overwrite results, attempts, or ids. `status` is deliberately
      // NOT here: it is owned by the publisher, and letting a client set
      // "published" would both block cancellation and guarantee the post never
      // goes out. Use DELETE to cancel.
      const allowed = ["caption", "title", "scheduledAt", "targets"];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      if (patch.scheduledAt) patch.scheduledAt = new Date(patch.scheduledAt as string).toISOString();

      let updated: unknown = null;
      await mutateSchedule((items) =>
        items.map((it) => {
          // Anything already sent is history and stays untouched.
          if (it.id !== id || it.status === "published") return it;
          updated = { ...it, ...patch, updatedAt: new Date().toISOString() };
          return updated;
        })
      );
      if (!updated) return json({ error: "not found, or already published" }, 404);
      return json({ item: updated });
    }

    if (req.method === "DELETE") {
      if (!id) return json({ error: "id is required" }, 400);
      // purge removes the record outright, for clearing history. It does not
      // and cannot un-publish anything already sent to a platform.
      const purge = url.searchParams.get("purge") === "1";
      let found = false;

      if (purge) {
        await mutateSchedule((items) => {
          const next = items.filter((it) => it.id !== id);
          found = next.length !== items.length;
          return next;
        });
        if (!found) return json({ error: "not found" }, 404);
        return json({ ok: true, purged: true });
      }

      await mutateSchedule((items) =>
        items.map((it) => {
          if (it.id !== id || it.status === "published") return it;
          found = true;
          return { ...it, status: "cancelled", updatedAt: new Date().toISOString() };
        })
      );
      if (!found) {
        return json(
          { error: "not found, or already published (use ?purge=1 to remove the record)" },
          404
        );
      }
      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
};

export const config: Config = {
  path: "/api/schedule",
};
