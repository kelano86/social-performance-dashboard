// Storage for scheduled posts and their video files.
//
// Files live in Netlify Blobs and are served by a public endpoint, because
// Instagram publishes by fetching a URL rather than accepting uploaded bytes.
// That endpoint is deliberately unauthenticated: Instagram's fetcher carries no
// credentials. Keys are random and unguessable, and the file is about to be
// posted publicly anyway.

import { getStore, getDeployStore } from "@netlify/blobs";

export const SCHEDULE_STORE = "social-schedule";
export const MEDIA_STORE = "social-media";
export const SCHEDULE_KEY = "items";

function pick(name) {
  const ctx = globalThis.Netlify?.context?.deploy?.context;
  return ctx === "production" || ctx === undefined
    ? getStore({ name, consistency: "strong" })
    : getDeployStore({ name, consistency: "strong" });
}

export const scheduleStore = () => pick(SCHEDULE_STORE);
export const mediaStore = () => pick(MEDIA_STORE);

/** Unguessable id, since it doubles as the public media path. */
export function newId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readSchedule() {
  const items = await scheduleStore().get(SCHEDULE_KEY, { type: "json" });
  return Array.isArray(items) ? items : [];
}

export async function writeSchedule(items) {
  await scheduleStore().setJSON(SCHEDULE_KEY, items);
}

/**
 * Last write wins on this blob, so every mutation goes through here and the
 * whole list is re-read immediately before the change. Two writers a
 * millisecond apart could still clobber each other, but the only writers are
 * one person and one cron, so a lock would be more machinery than the risk
 * justifies.
 */
export async function mutateSchedule(fn) {
  const items = await readSchedule();
  const next = await fn(items);
  await writeSchedule(next);
  return next;
}

export const STATUSES = ["scheduled", "publishing", "published", "failed", "cancelled"];

/** Shape of one scheduled release. Both platforms are optional. */
export function makeItem({ id, mediaId, filename, caption, title, scheduledAt, targets, sizeBytes, contentType }) {
  return {
    id,
    mediaId,
    filename,
    sizeBytes: sizeBytes ?? null,
    contentType: contentType || "video/mp4",
    caption: caption || "",
    title: title || "",
    scheduledAt,
    targets: {
      instagram: Boolean(targets?.instagram),
      youtube: Boolean(targets?.youtube),
    },
    results: {
      // Per-platform outcome, filled in by the publisher.
      instagram: { status: "pending", permalink: null, error: null, at: null },
      youtube: { status: "pending", permalink: null, error: null, at: null },
    },
    status: "scheduled",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
