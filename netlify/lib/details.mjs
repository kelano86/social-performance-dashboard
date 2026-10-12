// Post details and the Instagram daily history, fetched by the details
// background function every 6 hours (netlify/functions/details-background.mts).
//
// The scheduled refresh has a 30 second budget and already uses most of it, so
// everything here lives in a background function (15 minutes) instead:
//
//   - Instagram account history (igdaily.mjs): daily views with their follower
//     split, and follows_and_unfollows. Backfilled here, read by the refresh.
//   - Per post, for the Content tab's row drop-down:
//       Instagram  follows, profile_visits, reposts, views by follow type
//       YouTube    engagedViews (one query for all videos), views by
//                  subscribedStatus (one query per video)
//
// In the social-dashboard store:
//   details/latest  { generatedAt, durationMs, warnings, requests, igDaily,
//                     ig: { <mediaId>: record }, yt: { <videoId>: record } }
//
// A record carries its own fetchedAt, its values, and `missing`: field ->
// "unsupported" | "pending" | "failed" | "none" (no views reported), so the UI
// can say why a value is absent.
// Posts older than FRESH_DAYS whose values were already fetched keep them and
// are not asked again: they have stopped changing, and it keeps steady-state
// runs small. A failed post keeps its previous values and never stops the rest.

import { LATEST_KEY } from "./refresh.mjs";
import { readIgDaily, writeIgDaily } from "./igdaily.mjs";
import {
  metaConfigured,
  instagramSession,
  fetchInstagramDaily,
  mediaDetailsFetcher,
  dailyWindow,
  mapLimit,
  MEDIA_WINDOW_DAYS,
} from "./meta.mjs";
import { googleConfigured, youtubeDetailsSession } from "./google.mjs";

export const DETAILS_KEY = "details/latest";
export const FRESH_DAYS = 30;
const DAY = 86400000;
// Individual post failures are listed up to this many, then summarised.
const MAX_POST_WARNINGS = 5;

const iso = (ms) => new Date(ms).toISOString();
const postedAt = (p) => Date.parse(p.publishedAt || (p.date ? p.date + "T00:00:00Z" : ""));

/** A post needs fetching unless it is old and a previous run already got its values. */
function needsFetch(post, prev, now) {
  const t = postedAt(post);
  const old = Number.isFinite(t) && now - t > FRESH_DAYS * DAY;
  if (!old || !prev || !prev.fetchedAt || prev.error) return true;
  // Only a value still on its way is worth asking for again.
  return Object.values(prev.missing || {}).some((reason) => reason === "pending" || reason === "failed");
}

async function forPosts(posts, prevById, now, fetchOne, label, warnings) {
  const out = {};
  const failures = [];
  let fetched = 0;
  let kept = 0;
  const todo = [];
  for (const p of posts) {
    const prev = prevById[p.id];
    if (needsFetch(p, prev, now)) todo.push(p);
    else {
      out[p.id] = prev;
      kept++;
    }
  }
  await mapLimit(todo, 4, async (p) => {
    try {
      out[p.id] = { ...(await fetchOne(p)), fetchedAt: iso(now) };
      fetched++;
    } catch (err) {
      const prev = prevById[p.id];
      // Stale values beat none; the error says they are stale.
      out[p.id] = { ...(prev || {}), fetchedAt: prev?.fetchedAt || null, error: err?.message || String(err), errorAt: iso(now) };
      failures.push(`${p.id}: ${err?.message || err}`);
    }
  });
  if (failures.length) {
    warnings.push(
      failures.length <= MAX_POST_WARNINGS
        ? `${label}: ${failures.length} post(s) failed: ${failures.join("; ")}`
        : `${label}: ${failures.length} posts failed (first: ${failures[0]})`
    );
  }
  return { records: out, fetched, kept, failed: failures.length };
}

async function instagramPart(s, dataset, prevIg, now, warnings) {
  const session = await instagramSession();
  const part = { records: {}, igDaily: null, requests: 0 };

  // Account-level daily history: backfill and refresh the cache.
  try {
    const dates = dailyWindow();
    const cached = await readIgDaily(s, dates);
    const daily = await fetchInstagramDaily(session, cached);
    warnings.push(...daily.warnings);
    const written = await writeIgDaily(s, cached, daily.updates);
    part.igDaily = {
      requested: daily.requested,
      stored: daily.updates.size,
      cachedDays: dates.filter((d) => cached.has(d)).length,
      splitBreakdown: daily.splitBreakdown,
      followsRejected: daily.followsRejected,
      written,
    };
  } catch (err) {
    warnings.push(`ig daily history: ${err?.message || err}`);
  }

  // Per post, inside the same 2-year window the refresh uses.
  const cutoff = now - MEDIA_WINDOW_DAYS * DAY;
  const media = (dataset?.instagram?.media || []).filter((m) => {
    const t = postedAt(m);
    return m.id && (!Number.isFinite(t) || t >= cutoff);
  });
  const fetcher = mediaDetailsFetcher(session);
  const res = await forPosts(media, prevIg, now, (m) => fetcher.fetchMedia(m), "ig post details", warnings);
  const summary = fetcher.summary();
  if (summary) warnings.push(summary);
  part.records = res.records;
  part.counts = { fetched: res.fetched, kept: res.kept, failed: res.failed };
  part.requests = session.requests;
  return part;
}

async function youtubePart(dataset, prevYt, now, warnings) {
  const session = await youtubeDetailsSession();
  const videos = (dataset?.youtube?.videos || []).filter((v) => v.id);

  // One query for every video; if YouTube rejects engagedViews, only that
  // field is lost and the subscribed split still runs.
  let engaged = null;
  let engagedMissing = "failed";
  try {
    engaged = await session.engagedViews();
  } catch (err) {
    engagedMissing = err?.status === 400 ? "unsupported" : "failed";
    warnings.push(`yt engaged views: ${err?.message || err}`);
  }

  const res = await forPosts(videos, prevYt, now, async (v) => {
    const rec = { engagedViews: null, analyticsViews: null, subscribedViews: null, unsubscribedViews: null, missing: {} };
    if (engaged) {
      const e = engaged.get(v.id);
      if (e && e.engagedViews !== null) {
        rec.engagedViews = Number(e.engagedViews);
        rec.analyticsViews = e.views === null ? null : Number(e.views);
      } else {
        // Not in the report: either nothing has landed yet inside YouTube's
        // lag, or the video has had no views in the window.
        rec.missing.engagedViews = v.analyticsPending ? "pending" : "none";
      }
    } else {
      rec.missing.engagedViews = engagedMissing;
    }
    const split = await session.subscribedSplit(v.id);
    if (split) {
      rec.subscribedViews = split.subscribed;
      rec.unsubscribedViews = split.unsubscribed;
    } else {
      rec.missing.subscribedSplit = v.analyticsPending ? "pending" : "none";
    }
    if (v.analyticsPending) {
      for (const f of ["engagedViews", "subscribedSplit"]) if (!rec.missing[f]) rec.missing[f] = "pending";
    }
    return rec;
  }, "yt video details", warnings);
  // engagedViews came back for every video in that one query, so older videos
  // kept from an earlier run take the fresh figure too, at no extra request.
  if (engaged) {
    for (const [id, rec] of Object.entries(res.records)) {
      const e = engaged.get(id);
      if (!e || e.engagedViews === null || rec.error) continue;
      const missing = { ...(rec.missing || {}) };
      delete missing.engagedViews;
      res.records[id] = { ...rec, engagedViews: Number(e.engagedViews), analyticsViews: e.views === null ? null : Number(e.views), missing };
    }
  }
  return { records: res.records, counts: { fetched: res.fetched, kept: res.kept, failed: res.failed }, requests: session.requests };
}

/**
 * One background run: reads the latest dataset (for the post lists) and the
 * previous details, fetches both platforms in parallel, writes details/latest.
 * A platform that fails keeps its previous records and leaves a warning.
 */
export async function runDetails(s, { now = Date.now() } = {}) {
  const started = Date.now();
  const warnings = [];
  const [dataset, previous] = await Promise.all([
    s.get(LATEST_KEY, { type: "json" }),
    s.get(DETAILS_KEY, { type: "json" }),
  ]);
  if (!dataset) warnings.push("no refreshed dataset yet: post details skipped, daily history still fetched");
  const prev = { ig: previous?.ig || {}, yt: previous?.yt || {} };

  const [ig, yt] = await Promise.all([
    metaConfigured()
      ? instagramPart(s, dataset, prev.ig, now, warnings).catch((err) => {
          warnings.push(`instagram details: ${err?.message || err}`);
          return null;
        })
      : null,
    googleConfigured()
      ? youtubePart(dataset, prev.yt, now, warnings).catch((err) => {
          warnings.push(`youtube details: ${err?.message || err}`);
          return null;
        })
      : null,
  ]);

  const out = {
    generatedAt: iso(now),
    durationMs: Date.now() - started,
    warnings,
    requests: { instagram: ig ? ig.requests : 0, youtube: yt ? yt.requests : 0 },
    counts: { instagram: ig?.counts || null, youtube: yt?.counts || null },
    igDaily: ig?.igDaily || previous?.igDaily || null,
    ig: ig ? ig.records : prev.ig,
    yt: yt ? yt.records : prev.yt,
  };
  await s.setJSON(DETAILS_KEY, out);
  return out;
}

/** What /api/details returns for one post: its record, or null when there is none. */
export function detailsFor(blob, platform, id) {
  const k = platform === "instagram" ? "ig" : platform === "youtube" ? "yt" : null;
  const rec = k && blob && blob[k] && Object.prototype.hasOwnProperty.call(blob[k], id) ? blob[k][id] : null;
  return {
    platform,
    id,
    generatedAt: blob?.generatedAt || null,
    schedule: "every 6 hours",
    freshDays: FRESH_DAYS,
    details: rec,
  };
}

export async function readDetails(s, platform, id) {
  return detailsFor(await s.get(DETAILS_KEY, { type: "json" }), platform, id);
}
