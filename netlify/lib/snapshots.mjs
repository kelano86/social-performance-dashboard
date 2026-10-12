// View snapshots.
//
// Instagram returns only each media's lifetime view total, never a per-media
// time series, and the app's own per-reel graph stops after about 30 days. So
// every refresh records every post's lifetime totals, and "views gained" over
// any window is the difference between two of those records. History starts at
// the first deploy and cannot be backfilled.
//
// In the social-dashboard store:
//   snaps/YYYY-MM  one blob per UTC month, an array of
//                  { t, ig: { id: [views, likes, comments, shares, saves] },
//                       yt: { id: [views, likes, comments] } }
//   snaps/index    { months: [keys], since, published: { ig: { id: iso }, yt: {...} } }
//
// Everything here takes the store as an argument, so it runs unchanged against
// Netlify Blobs, the local dev server's file and the test stub.

import { env } from "./env.mjs";

export const SNAP_PREFIX = "snaps/";
export const SNAP_INDEX_KEY = "snaps/index";
export const WINDOW_DAYS = [1, 7, 14, 30];

const DAY = 86400000;
// A manual refresh straight after a scheduled one replaces it rather than
// adding a near-duplicate point.
const REPLACE_WITHIN_MS = 30 * 60000;
// A window's baseline must be at least this share of the window old. Otherwise
// the window is partial and measured from the oldest snapshot there is.
const MIN_BASELINE_SHARE = 0.8;
const TOP_ROWS = 10;
const KEYS = { instagram: "ig", youtube: "yt" };

// The time zone a "day" is counted in for views gained per day: an IANA name
// such as "Europe/London" or "America/New_York". Defaults to UTC.
export const dashTz = () => env("DASH_TZ") || "UTC";

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const at = (e) => Date.parse(e.t);
const iso = (ms) => new Date(ms).toISOString();

export const monthKey = (ms) => SNAP_PREFIX + iso(ms).slice(0, 7);

function monthKeysBetween(fromMs, toMs) {
  const keys = [];
  const a = new Date(fromMs);
  const b = new Date(toMs);
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth();
  while (y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth())) {
    keys.push(`${SNAP_PREFIX}${y}-${String(m + 1).padStart(2, "0")}`);
    if (++m === 12) {
      m = 0;
      y++;
    }
  }
  return keys;
}

const dayFormats = new Map();
/** YYYY-MM-DD of an instant in the given time zone. */
export function localDay(ms, tz = dashTz()) {
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function readIndex(raw) {
  const i = raw && typeof raw === "object" ? raw : {};
  return {
    months: Array.isArray(i.months) ? i.months.filter((k) => typeof k === "string") : [],
    since: typeof i.since === "string" ? i.since : null,
    published: { ig: { ...(i.published?.ig || {}) }, yt: { ...(i.published?.yt || {}) } },
  };
}

async function readEntries(s, keys) {
  const blobs = await Promise.all(keys.map((k) => s.get(k, { type: "json" })));
  return blobs.flatMap((b) => (Array.isArray(b) ? b : [])).sort((a, b) => at(a) - at(b));
}

/**
 * shape() turns a missing view count into 0, so a media whose insights call
 * failed would be recorded as a collapse to zero followed by a spike. The raw
 * rows still say whether a real number came back.
 */
function idsWithViews(rows, idField, fields) {
  const ids = new Set();
  for (const r of rows || []) {
    if (r && r[idField] && fields.some((f) => num(r[f]) !== null)) ids.add(String(r[idField]));
  }
  return ids;
}

export function snapshotEntry(dataset, raw, t = Date.parse(dataset.generatedAt)) {
  const igKnown = raw ? idsWithViews(raw.ig_media, "media_id", ["media_views"]) : null;
  const ytKnown = raw ? idsWithViews(raw.yt_videos, "video", ["video_view_count", "views"]) : null;
  const entry = { t: iso(t), ig: {}, yt: {} };
  for (const m of dataset.instagram?.media || []) {
    if (!m.id || num(m.views) === null || (igKnown && !igKnown.has(String(m.id)))) continue;
    entry.ig[m.id] = [num(m.views), num(m.likes), num(m.comments), num(m.shares), num(m.saves)];
  }
  for (const v of dataset.youtube?.videos || []) {
    if (!v.id || num(v.views) === null || (ytKnown && !ytKnown.has(String(v.id)))) continue;
    entry.yt[v.id] = [num(v.views), num(v.likes), num(v.comments)];
  }
  return entry;
}

function publishedFrom(dataset) {
  const out = { ig: {}, yt: {} };
  for (const m of dataset.instagram?.media || []) if (m.id && m.publishedAt) out.ig[m.id] = m.publishedAt;
  for (const v of dataset.youtube?.videos || []) if (v.id && v.publishedAt) out.yt[v.id] = v.publishedAt;
  return out;
}

/**
 * Views gained per post between two snapshots. A post missing from the
 * baseline started at 0 only if it was published after the baseline; otherwise
 * its starting count is unknown and it is left out (null) rather than guessed.
 * Platforms occasionally revise a count down: that is shown as no gain and
 * counted, never as a negative.
 */
export function compare(base, end, published = {}) {
  const baseT = at(base);
  const out = { totalGained: 0, revised: 0, unknown: 0, byPlatform: {}, rows: [] };
  for (const [platform, k] of Object.entries(KEYS)) {
    const p = { totalGained: 0, revised: 0, unknown: 0, posts: 0 };
    const before = base[k] || {};
    for (const [id, vals] of Object.entries(end[k] || {})) {
      const total = num(vals?.[0]);
      if (total === null) continue;
      p.posts++;
      const prev = num(before[id]?.[0]);
      let gained;
      if (prev !== null) {
        gained = total - prev;
        if (gained < 0) {
          gained = 0;
          p.revised++;
        }
      } else {
        const pub = Date.parse(published[k]?.[id]);
        gained = Number.isFinite(pub) && pub > baseT ? total : null;
      }
      if (gained === null) p.unknown++;
      else p.totalGained += gained;
      out.rows.push({ platform, id, gained, total });
    }
    out.byPlatform[platform] = p;
    out.totalGained += p.totalGained;
    out.revised += p.revised;
    out.unknown += p.unknown;
  }
  out.rows.sort((a, b) => (b.gained ?? -1) - (a.gained ?? -1) || b.total - a.total);
  return out;
}

/**
 * Account-level views over the complete days the window covers, from the daily
 * series the dataset already carries. YouTube's settles 2-3 days late, so `to`
 * says how far it actually reaches.
 */
function accountViews(daily, fromMs, now) {
  const today = iso(now).slice(0, 10);
  const first = iso(fromMs).slice(0, 10);
  const out = {};
  for (const platform of ["instagram", "youtube"]) {
    const pts = (daily || []).filter((p) => p.date >= first && p.date < today && num(p[platform]) !== null);
    out[platform] = pts.length
      ? {
          from: pts[0].date,
          to: pts[pts.length - 1].date,
          days: pts.length,
          views: pts.reduce((a, p) => a + num(p[platform]), 0),
        }
      : null;
  }
  return out;
}

/**
 * The overall top rows plus each platform's own top rows, so a one-platform
 * view of the Top videos table is not starved when the other platform fills
 * the overall top. Keeps the overall order.
 */
function topRows(rows) {
  const seen = {};
  return rows.filter((r, i) => {
    seen[r.platform] = (seen[r.platform] || 0) + 1;
    return i < TOP_ROWS || seen[r.platform] <= TOP_ROWS;
  });
}

export function windowFor(entries, latest, days, published, daily) {
  const now = at(latest);
  const span = days * DAY;
  const target = now - span;
  let best = null;
  let oldest = null;
  for (const e of entries) {
    if (e === latest) continue;
    const t = at(e);
    if (!(t < now)) continue;
    if (!oldest || t < at(oldest)) oldest = e;
    if (now - t >= span * MIN_BASELINE_SHARE && (!best || Math.abs(t - target) < Math.abs(at(best) - target))) {
      best = e;
    }
  }
  const base = best || oldest;
  if (!base) return null;
  const c = compare(base, latest, published);
  return {
    days,
    from: base.t,
    to: latest.t,
    partial: !best,
    totalGained: c.totalGained,
    revised: c.revised,
    unknown: c.unknown,
    byPlatform: c.byPlatform,
    rows: topRows(c.rows),
    accountViews: accountViews(daily, at(base), now),
  };
}

/**
 * Records this refresh's snapshot and returns the summary that goes on the
 * dataset. Reads the index and the month blobs a 30-day window can reach (two,
 * three after February) in one parallel round, writes the current month, and
 * writes the index only when it changed.
 */
export async function recordSnapshots(s, dataset, raw) {
  const now = Date.parse(dataset.generatedAt);
  if (!Number.isFinite(now)) throw new Error("dataset has no generatedAt");
  const entry = snapshotEntry(dataset, raw, now);
  const current = monthKey(now);
  const keys = monthKeysBetween(now - (Math.max(...WINDOW_DAYS) + 1) * DAY, now);

  const [rawIndex, ...blobs] = await Promise.all([
    s.get(SNAP_INDEX_KEY, { type: "json" }),
    ...keys.map((k) => s.get(k, { type: "json" })),
  ]);
  const months = new Map(keys.map((k, i) => [k, Array.isArray(blobs[i]) ? blobs[i] : []]));
  const list = months.get(current);
  const index = readIndex(rawIndex);
  let changed = false;

  const last = list[list.length - 1];
  if (last && now - at(last) < REPLACE_WITHIN_MS) {
    list[list.length - 1] = entry;
    if (index.since === last.t) {
      index.since = entry.t;
      changed = true;
    }
  } else {
    list.push(entry);
  }

  const entries = keys.flatMap((k) => months.get(k)).sort((a, b) => at(a) - at(b));
  if (!index.months.includes(current)) {
    index.months.push(current);
    index.months.sort();
    changed = true;
  }
  if (!index.since) {
    index.since = entries[0].t;
    changed = true;
  }
  for (const [k, map] of Object.entries(publishedFrom(dataset))) {
    for (const [id, when] of Object.entries(map)) {
      if (index.published[k][id] !== when) {
        index.published[k][id] = when;
        changed = true;
      }
    }
  }

  await Promise.all([s.setJSON(current, list), changed ? s.setJSON(SNAP_INDEX_KEY, index) : null]);

  return {
    since: index.since,
    latestAt: entry.t,
    tz: dashTz(),
    windows: Object.fromEntries(
      WINDOW_DAYS.map((d) => [String(d), windowFor(entries, entry, d, index.published, dataset.daily)])
    ),
  };
}

/**
 * One post's recorded lifetime views, plus views gained per local day, taken
 * from the last snapshot of each day. A post published before tracking began
 * gets an `estimate`: a straight line from 0 at posting to its first recorded
 * total, which is all that can honestly be said about that stretch. It never
 * produces daily bars.
 */
export function seriesFor(entries, platform, id, { tz = dashTz(), since = null, publishedAt = null } = {}) {
  const k = KEYS[platform];
  const points = [];
  for (const e of entries) {
    const views = num(e[k]?.[id]?.[0]);
    if (views !== null) points.push({ t: e.t, views });
  }
  const first = points[0];
  const pub = Date.parse(publishedAt);
  const sinceMs = Date.parse(since);
  const knownPub = first && Number.isFinite(pub) && pub <= at(first);
  const afterTrackingBegan = knownPub && Number.isFinite(sinceMs) && pub >= sinceMs;
  const estimate =
    knownPub && !afterTrackingBegan && pub < at(first)
      ? { from: { t: iso(pub), views: 0 }, to: { t: first.t, views: first.views } }
      : null;

  const daily = [];
  // Published after tracking began and caught by the next refresh or so: it was
  // at 0 when posted, so its first day counts from there. Otherwise the first
  // day only covers what was tracked.
  const fromZero = afterTrackingBegan && at(first) - pub <= 6 * 3600000;
  let prev = fromZero ? { t: iso(pub), views: 0 } : null;
  for (let i = 0; i < points.length; ) {
    const day = localDay(at(points[i]), tz);
    let j = i;
    while (j + 1 < points.length && localDay(at(points[j + 1]), tz) === day) j++;
    const last = points[j];
    const base = prev || points[i];
    const gained = last.views - base.views;
    const row = { date: day, gained: Math.max(0, gained), from: base.t, to: last.t };
    if (!prev) row.partial = true;
    if (gained < 0) row.revised = true;
    daily.push(row);
    prev = last;
    i = j + 1;
  }

  return {
    id,
    platform,
    tz,
    since,
    publishedAt: publishedAt || null,
    trackedFromPosting: Boolean(afterTrackingBegan),
    estimate,
    points,
    daily,
  };
}

export async function readSeries(s, platform, id, tz = dashTz()) {
  const index = readIndex(await s.get(SNAP_INDEX_KEY, { type: "json" }));
  const entries = await readEntries(s, index.months);
  return seriesFor(entries, platform, id, {
    tz,
    since: index.since,
    publishedAt: index.published[KEYS[platform]]?.[id] || null,
  });
}

/**
 * Views gained across both platforms on one local day: last snapshot of the
 * day against the last snapshot before it, with the same rules as the windows.
 */
export function dayBreakdown(entries, day, { tz = dashTz(), since = null, published = {}, now = Date.now() } = {}) {
  const today = localDay(now, tz);
  const sinceDay = since ? localDay(Date.parse(since), tz) : null;
  const inDay = entries.filter((e) => localDay(at(e), tz) === day);
  if (!inDay.length) {
    const tracked = Boolean(sinceDay) && day >= sinceDay && day <= today;
    return { day, tz, since, tracked, empty: tracked };
  }
  const end = inDay[inDay.length - 1];
  let base = null;
  for (const e of entries) if (localDay(at(e), tz) < day) base = e;
  const partial = !base;
  if (!base) base = inDay[0];
  const c = compare(base, end, published);
  return {
    day,
    tz,
    since,
    tracked: true,
    partial,
    complete: day < today,
    from: base.t,
    to: end.t,
    totalGained: c.totalGained,
    revised: c.revised,
    unknown: c.unknown,
    byPlatform: c.byPlatform,
    rows: c.rows.slice(0, TOP_ROWS),
  };
}

export async function readDay(s, day, tz = dashTz(), now = Date.now()) {
  const index = readIndex(await s.get(SNAP_INDEX_KEY, { type: "json" }));
  // The day itself plus a few days either side, for the baseline before it.
  const mid = Date.parse(`${day}T12:00:00Z`);
  const keys = monthKeysBetween(mid - 3 * DAY, mid + 2 * DAY).filter((k) => index.months.includes(k));
  const entries = await readEntries(s, keys);
  return dayBreakdown(entries, day, { tz, since: index.since, published: index.published, now });
}
