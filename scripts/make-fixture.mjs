// Builds a fully synthetic local fixture, so the dashboard can be run and
// checked with no credentials and no network:
//
//   .local/sample.json     what /api/data returns, built by the real shape.mjs
//                          from raw rows shaped like google.mjs / meta.mjs output
//   .local/snapshots.json  20 days of view snapshots, one every 3 hours, recorded
//                          by the real snapshot code, for /api/snapshots
//   .local/details.json    post details as the details background function
//                          writes them, for /api/details
//
// Every account name, title, id, link and number below is invented. The random
// numbers come from a seeded generator, so every run writes the same files.
//
//   node scripts/make-fixture.mjs
//   node scripts/dev-server.mjs 5310

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shape } from "../netlify/lib/shape.mjs";
import { recordSnapshots } from "../netlify/lib/snapshots.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- randomness
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260520);
const between = (lo, hi) => lo + (hi - lo) * rand();
const int = (lo, hi) => Math.floor(between(lo, hi + 1));
const logBetween = (lo, hi) => Math.exp(between(Math.log(lo), Math.log(hi)));
const pick = (list) => list[Math.floor(rand() * list.length)];
const pad = (n, w = 2) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- time
const DAY = 86400000;
const H = 3600000;
// The fixture is frozen at this moment: "now" for every chart and table.
const AS_OF = Date.parse("2026-05-20T09:00:00Z");
const TODAY = Date.parse(new Date(AS_OF).toISOString().slice(0, 10) + "T00:00:00Z");
const TRACKING_SINCE = AS_OF - 20 * DAY; // first view snapshot
const iso = (ms) => new Date(ms).toISOString();
const isoDay = (ms) => iso(ms).slice(0, 10);
const igTime = (ms) => iso(ms).replace(".000Z", "+0000"); // Instagram's timestamp format
const quarterHour = (ms) => Math.round(ms / (15 * 60000)) * 15 * 60000;
const EXAMPLE = "https://example.com";

// Lifetime views grow fast in the first days after posting, then keep
// trickling in. The same curve drives the daily series and the snapshot
// history, so the charts agree with each other.
const growth = (ageDays) => (ageDays <= 0 ? 0 : 1 - Math.exp(-ageDays / 1.8) + 0.004 * ageDays);
const viewsAt = (total, postedMs, t) =>
  Math.round((total * growth((t - postedMs) / DAY)) / growth((AS_OF - postedMs) / DAY));

const TOPICS = [
  "three quick editing tips", "a behind-the-scenes look", "answering a viewer question",
  "a before and after", "the setup I use", "a 30-second tutorial", "a common mistake to avoid",
  "a day in the life", "a quick product demo", "testing a new idea", "a myth, busted",
  "the tool of the week", "a small trick that saves time",
];

// ---------------------------------------------------------------- Instagram
// 30 posts over about four months, every 2.5 to 4.5 days: reels, with a feed
// carousel now and then. Plus one reel posted two hours ago whose insights
// Instagram has not computed yet (it sends zeros for reach, skip rate and
// watch time until it has them).
const igPlan = [];
{
  let age = 1.3;
  for (let i = 0; i < 30; i++) {
    igPlan.push({ t: quarterHour(AS_OF - age * DAY), feed: i % 7 === 3 });
    age += between(2.5, 4.5);
  }
  igPlan.reverse(); // oldest first, so the numbering runs with time
}
// One reel about 12 days old goes viral, inside the snapshot history.
const viralIndex = igPlan.reduce((best, p, i) =>
  !p.feed && Math.abs((AS_OF - p.t) / DAY - 12) < Math.abs((AS_OF - igPlan[best].t) / DAY - 12) ? i : best,
  igPlan.findIndex((p) => !p.feed));

let reelNo = 0;
let carouselNo = 0;
const igRows = igPlan.map((p, i) => {
  const n = p.feed ? ++carouselNo : ++reelNo;
  const id = `ig-example-${pad(i + 1)}`;
  const views = p.feed ? Math.round(logBetween(600, 4000)) : i === viralIndex ? 184000 : Math.round(logBetween(900, 30000));
  const likes = Math.round(views * between(0.015, 0.045));
  const comments = Math.round(views * between(0.001, 0.006));
  const saved = Math.round(views * between(0.004, 0.03));
  const shares = Math.round(views * between(0.002, 0.015));
  const watchMs = p.feed ? null : int(5500, 16000);
  return {
    date: isoDay(p.t),
    timestamp: igTime(p.t),
    media_id: id,
    media_shortcode: `EX${pad(i + 1, 3)}`,
    media_permalink: `${EXAMPLE}/instagram/${id}`,
    media_type: p.feed ? "CAROUSEL_ALBUM" : "VIDEO",
    media_product_type: p.feed ? "FEED" : "REELS",
    media_caption: `${p.feed ? "Example carousel" : "Example reel"} ${n}: ${pick(TOPICS)}`,
    media_thumbnail_url: null,
    media_views: views,
    media_reach: Math.round(views * between(0.68, 0.84)),
    media_like_count: likes,
    media_comments_count: comments,
    media_saved: saved,
    media_shares: shares,
    media_engagement: likes + comments + saved + shares,
    media_reel_avg_watch_time: watchMs,
    media_reel_total_watch_time: watchMs === null ? null : watchMs * views,
    media_reel_skip_rate: p.feed ? null : Number(between(0.33, 0.66).toFixed(3)), // a fraction, as meta.mjs emits it
    _t: p.t,
    _reel: p.feed ? null : n,
  };
});
const FRESH_T = AS_OF - 2 * H;
igRows.push({
  ...igRows[igRows.length - 1],
  date: isoDay(FRESH_T),
  timestamp: igTime(FRESH_T),
  media_id: "ig-example-31",
  media_shortcode: "EX031",
  media_permalink: `${EXAMPLE}/instagram/ig-example-31`,
  media_type: "VIDEO",
  media_product_type: "REELS",
  media_caption: `Example reel ${++reelNo}: just posted`,
  media_views: 2412,
  media_reach: 0,
  media_like_count: 61,
  media_comments_count: 14,
  media_saved: 40,
  media_shares: 9,
  media_engagement: 124,
  media_reel_avg_watch_time: 0,
  media_reel_total_watch_time: 0,
  media_reel_skip_rate: 0,
  _t: FRESH_T,
  _reel: reelNo,
});

// ---------------------------------------------------------------- YouTube
// Most reels are cross-posted as a Short a few hours later (some land after
// midnight UTC, so the release pairing has to look a day either side). Two
// long-form videos, and one unlisted video that the dashboard leaves out.
// Videos younger than about 2.5 days have no analytics yet (YouTube's lag):
// their lifetime count is live, everything else is blank.
const ytPlan = [];
igRows.forEach((r, i) => {
  if (!r._reel) return;
  const age = (AS_OF - r._t) / DAY;
  if (age > 88 || (i % 4 === 1 && i !== viralIndex)) return; // some reels are Instagram-only
  const t = r._t === FRESH_T ? AS_OF - H : quarterHour(r._t + between(1, 7) * H);
  const views = i === viralIndex ? 26300 : r._t === FRESH_T ? 180 : Math.max(60, Math.round(r.media_views * between(0.08, 0.35)));
  ytPlan.push({ t, views, title: `Example short ${r._reel}: ${r.media_caption.split(": ")[1]}`, kind: "shorts", privacy: "public" });
});
ytPlan.push({ t: quarterHour(AS_OF - 41 * DAY), views: 1240, title: "Example video 1: a longer walkthrough", kind: "videoOnDemand", privacy: "public" });
ytPlan.push({ t: quarterHour(AS_OF - 140 * DAY), views: 3410, title: "Example video 2: a full tutorial", kind: "videoOnDemand", privacy: "public" });
ytPlan.push({ t: quarterHour(AS_OF - 60 * DAY), views: 37, title: "Example unlisted clip", kind: "videoOnDemand", privacy: "unlisted" });
ytPlan.sort((a, b) => a.t - b.t);

const ytRows = ytPlan.map((p, i) => {
  const id = `yt-example-${pad(i + 1)}`;
  const short = p.kind === "shorts";
  const pending = AS_OF - p.t < 2.5 * DAY;
  const analytics = pending ? 0 : Math.round(p.views * 0.97);
  const avgPct = short ? between(55, 115) : between(28, 45);
  const lengthSec = short ? int(20, 58) : int(480, 900);
  const avgSec = (lengthSec * avgPct) / 100;
  const likes = Math.round(p.views * between(0.02, 0.05));
  const comments = Math.round(p.views * between(0.001, 0.006));
  return {
    video: id,
    video_title: p.title,
    videourl: `${EXAMPLE}/youtube/${id}`,
    videoimage: null,
    published_at: iso(p.t),
    video_length: `${Math.floor(lengthSec / 60)}:${pad(lengthSec % 60)}`,
    creator_content_type: p.kind,
    privacy_status: p.privacy,
    views: analytics,
    engaged_views: pending ? null : analytics,
    estimated_minutes_watched: pending ? null : Math.round((analytics * avgSec) / 60),
    average_view_duration: pending ? null : Number(avgSec.toFixed(1)),
    average_view_percentage: pending ? null : Number(avgPct.toFixed(2)),
    likes: pending ? null : likes,
    comments: pending ? null : comments,
    shares: pending ? null : Math.round(p.views * between(0.002, 0.01)),
    subscribers_gained: pending ? null : Math.round(p.views * between(0.001, 0.008)),
    video_view_count: p.views,
    video_like_count: likes,
    video_comment_count: comments,
    _t: p.t,
  };
});
const ytPublic = ytRows.filter((r) => r.privacy_status === "public");

// ---------------------------------------------------------------- daily series
// 90 complete days before today. YouTube reports through three days ago.
const days = [];
for (let i = 90; i >= 1; i--) days.push(TODAY - i * DAY);
const gainedBetween = (rows, field, s, e) =>
  rows.reduce((a, r) => a + viewsAt(r[field], r._t, e) - viewsAt(r[field], r._t, s), 0);

const ig_daily = [];
const ig_followers_daily = [];
const ig_follows_daily = [];
const yt_daily = [];
const yt_subscribed_daily = [];
const yt_subs_daily = [];
const yt_traffic = [];
const SOURCES = [
  ["SHORTS", 0.68], ["YT_SEARCH", 0.08], ["YT_OTHER_PAGE", 0.07], ["SUBSCRIBER", 0.05], ["YT_CHANNEL", 0.04],
  ["EXT_URL", 0.03], ["PLAYLIST", 0.02], ["NO_LINK_OTHER", 0.02], ["RELATED_VIDEO", 0.01],
];
for (const s of days) {
  const e = s + DAY;
  const daysAgo = Math.round((TODAY - s) / DAY);
  const date = isoDay(s);

  // Instagram: views on the posts above plus a background of older posts.
  const views = gainedBetween(igRows, "media_views", s, e) + int(150, 450);
  const row = { date, views, reach_1d: Math.round(views * between(0.6, 0.72)), accounts_engaged: Math.round(views * between(0.02, 0.04)),
    views_follower: null, views_non_follower: null, views_unknown: null };
  // The follower split exists for the days the details function has cached.
  if (daysAgo <= 45) {
    const share = views > 40000 ? between(0.05, 0.08) : views > 8000 ? between(0.1, 0.18) : between(0.22, 0.38);
    row.views_follower = Math.round(views * share);
    row.views_unknown = Math.round(views * 0.01);
    row.views_non_follower = views - row.views_follower - row.views_unknown;
  }
  ig_daily.push(row);
  // New followers per day (gross adds): Instagram only reports the last 29 days.
  const adds = Math.round(4 + views * between(0.0025, 0.0045));
  if (daysAgo <= 29) ig_followers_daily.push({ date, follower_count: adds });
  // Real follows and unfollows for the last 20 days; the 9 before that keep the
  // gross-adds reconstruction, so both kinds of day show in Follower growth.
  if (daysAgo <= 20) ig_follows_daily.push({ date, follows: adds, unfollows: Math.round(adds * between(0.08, 0.2)) + int(0, 3) });

  if (daysAgo < 3) continue; // YouTube's reporting lag
  const yv = gainedBetween(ytPublic, "video_view_count", s, e) + int(20, 90);
  yt_daily.push({ date, views: yv, estimated_minutes_watched: Math.round(yv * between(0.35, 0.5)),
    likes: Math.round(yv * 0.03), comments: Math.round(yv * 0.002), shares: Math.round(yv * 0.004) });
  const subscribed = Math.round(yv * between(0.04, 0.09));
  yt_subscribed_daily.push({ date, subscribed_views: subscribed, unsubscribed_views: yv - subscribed });
  const gained = Math.round(yv * between(0.002, 0.005)) + int(0, 1);
  const lost = rand() < 0.4 ? int(1, 2) : 0;
  // The API only returns days with movement.
  if (gained || lost) yt_subs_daily.push({ date, subscribers_gained_channel: gained, subscribers_lost_channel: lost });
  for (const [source, share] of SOURCES) {
    const v = Math.round(yv * share * between(0.8, 1.2));
    if (v > 0) yt_traffic.push({ date, traffic_source: source, views: v, estimated_minutes_watched: Math.round(v * 0.4) });
  }
}

// ---------------------------------------------------------------- audience
const jitter = (rows) => rows.map(([label, share]) => [label, share * between(0.85, 1.15)]);
const geoFor = (n) => {
  const total = yt_daily.slice(-n).reduce((a, r) => a + r.views, 0);
  return jitter([
    ["United States", 0.31], ["United Kingdom", 0.12], ["India", 0.1], ["Canada", 0.07], ["Germany", 0.06],
    ["Australia", 0.05], ["Brazil", 0.04], ["France", 0.04], ["Netherlands", 0.03], ["Spain", 0.03], ["Mexico", 0.02],
  ]).map(([country, share]) => ({ country, views: Math.round(total * share), estimated_minutes_watched: Math.round(total * share * 0.4) }));
};
const percentages = (rows) => {
  const j = jitter(rows);
  const sum = j.reduce((a, [, v]) => a + v, 0);
  return j.map(([label, v]) => [label, Number(((v / sum) * 100).toFixed(1))]);
};
const IG_FOLLOWERS = 12480;
const counts = (rows) => jitter(rows).map(([label, share]) => [label, Math.round(IG_FOLLOWERS * share)]);

// ---------------------------------------------------------------- retention
// Audience retention for the most viewed public videos past YouTube's lag: a
// drop in the first seconds, then a slow decay, above 100% at the start where
// viewers loop. Relative retention lands above typical (0.5) for some, below
// for others.
const retentionVideos = ytPublic
  .filter((r) => r.views > 0 && r.video_view_count >= 100)
  .sort((a, b) => b.video_view_count - a.video_view_count)
  .slice(0, 6);
const yt_retention = retentionVideos.flatMap((r) => {
  const short = r.creator_content_type === "shorts";
  const start = short ? between(0.95, 1.2) : between(0.85, 0.95);
  const decay = short ? between(0.9, 2.3) : between(2.2, 3);
  const rel = between(0.08, 0.42);
  return Array.from({ length: 51 }, (_, i) => {
    const e = i / 50;
    const watch = (e < 0.06 ? start - (start - 0.82) * (e / 0.06) : 0.82 * Math.exp(-decay * (e - 0.06))) + 0.06;
    return { video: r.video, elapsed_ratio: e, watch_ratio: Number(watch.toFixed(4)),
      relative_performance: Number(Math.min(1, rel + watch * 0.5).toFixed(3)) };
  });
});

// ---------------------------------------------------------------- raw
const strip = (rows) => rows.map(({ _t, _reel, ...r }) => r);
const ytPublicCount = ytPublic.length;
const raw = {
  yt_channel: [{
    channel_title: "Example Channel", channel_id: "example-channel", channel_image: null,
    subscriber_count: 1940, video_count: ytPublicCount,
    view_count: ytPublic.reduce((a, r) => a + r.video_view_count, 0) + 24800,
  }],
  yt_videos: strip(ytRows),
  yt_daily,
  yt_subscribed_daily,
  yt_subs_daily,
  yt_traffic,
  yt_geo_90: geoFor(90),
  yt_geo_30: geoFor(30),
  yt_geo_14: geoFor(14),
  yt_age: percentages([["age13-17", 3], ["age18-24", 21], ["age25-34", 37], ["age35-44", 22], ["age45-54", 10], ["age55-64", 5], ["age65-", 2]])
    .map(([viewer_age_group, viewer_percentage]) => ({ viewer_age_group, viewer_percentage })),
  yt_gender: percentages([["male", 61], ["female", 38.5], ["user_specified", 0.5]])
    .map(([viewer_gender, viewer_percentage]) => ({ viewer_gender, viewer_percentage })),
  yt_retention,
  ig_profile: [{ username: "example.creator", name: "Example Creator", followers_count: IG_FOLLOWERS, follows_count: 310, media_count: 164 }],
  ig_media: strip(igRows),
  ig_daily,
  ig_followers_daily,
  ig_follows_daily,
  ig_geo: counts([["US", 0.27], ["GB", 0.11], ["IN", 0.09], ["CA", 0.06], ["DE", 0.05], ["AU", 0.05], ["BR", 0.04], ["FR", 0.04], ["NL", 0.03], ["ES", 0.03]])
    .map(([audience_country_name, audience_country_size]) => ({ audience_country_name, audience_country_size })),
  ig_age: counts([["13-17", 0.015], ["18-24", 0.19], ["25-34", 0.38], ["35-44", 0.24], ["45-54", 0.11], ["55-64", 0.045], ["65+", 0.02]])
    .map(([audience_age_name, audience_age_size]) => ({ audience_age_name, audience_age_size })),
  ig_gender: counts([["M", 0.58], ["F", 0.39], ["U", 0.03]])
    .map(([audience_gender_name, audience_gender_size]) => ({ audience_gender_name, audience_gender_size })),
};

// ---------------------------------------------------------------- snapshots
// Every post's lifetime views at earlier moments, on the growth curve above,
// recorded by the real snapshot code every 3 hours. Two posts exercise the
// edge cases the Top videos notes explain:
//   - an older reel whose insights call "failed" exactly 24 hours ago, so it is
//     missing from the 24h baseline and left out of that window (unknown)
//   - an older reel whose count Instagram "revised down" over the last day
const olderReels = igRows.filter((r) => r._reel && r._t < TRACKING_SINCE - 10 * DAY);
const UNKNOWN_ID = olderReels[olderReels.length - 1].media_id;
const REVISED_ID = olderReels[olderReels.length - 2].media_id;
const posted = (r) => Date.parse(r.timestamp || r.published_at);
function rawAt(t) {
  return {
    ...raw,
    ig_media: raw.ig_media.filter((r) => posted(r) <= t).map((r) => {
      let views = viewsAt(r.media_views, posted(r), t);
      if (r.media_id === UNKNOWN_ID && t === AS_OF - DAY) views = null;
      if (r.media_id === REVISED_ID && t > AS_OF - 30 * H && t < AS_OF) views += 400;
      return { ...r, media_views: views };
    }),
    yt_videos: raw.yt_videos.filter((r) => posted(r) <= t).map((r) => ({
      ...r,
      views: r.views ? viewsAt(r.views, posted(r), t) : 0,
      video_view_count: viewsAt(r.video_view_count, posted(r), t),
    })),
  };
}
const blobs = new Map();
const memStore = {
  async get(key) { return blobs.has(key) ? structuredClone(blobs.get(key)) : null; },
  async setJSON(key, value) { blobs.set(key, structuredClone(value)); },
};
let snapshots = null;
for (let t = TRACKING_SINCE; t <= AS_OF; t += 3 * H) {
  const step = t === AS_OF ? raw : rawAt(t);
  const ds = shape(step);
  ds.generatedAt = iso(t);
  snapshots = await recordSnapshots(memStore, ds, step);
}

// ---------------------------------------------------------------- dataset
const dataset = shape(raw);
dataset.generatedAt = iso(AS_OF);
dataset.sources = { youtube: "direct", instagram: "direct", instagramAuth: "facebook" };
dataset.tokenStatus = { expiresAt: iso(AS_OF + 41 * DAY), daysLeft: 41, neverExpires: false };
dataset.snapshots = snapshots;
// Measured follower snapshots for the last 11 days, as the refresh appends
// them; the levels match the reconstruction so the chart joins up.
const derived = new Map(dataset.derivedHistory.map((h) => [h.date, h]));
dataset.history = [];
for (let i = 10; i >= 0; i--) {
  const date = isoDay(AS_OF - i * DAY);
  const h = derived.get(date);
  dataset.history.push({
    date,
    ytFollowers: i === 0 ? dataset.youtube.followers : h?.youtube ?? null,
    igFollowers: i === 0 ? dataset.instagram.followers : h?.instagram ?? null,
    ytLifetimeViews: dataset.youtube.lifetimeViews - i * 900,
    igViews: dataset.instagram.lifetimeViews - i * 7000,
    totalEngagement: dataset.totals.engagement - i * 400,
  });
}
dataset.warnings = [];
dataset.durationMs = 14210;
dataset.rowCounts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.length]));

// ---------------------------------------------------------------- post details
// Shaped like details/latest from the details background function, last run
// at 06:30 that morning. Covers every state the drop-down strip has to show:
// full values, metrics a platform does not provide, a fresh post still
// pending, a failed fetch, and posts never fetched (absent).
const DETAILS_AT = iso(AS_OF - 2.5 * H);
const details = { generatedAt: DETAILS_AT, durationMs: 41210, warnings: [], ig: {}, yt: {} };
const igMedia = dataset.instagram.media;
const feedPosts = igMedia.filter((m) => m.format === "FEED");
for (const m of igMedia) {
  if (m.id === feedPosts[0].id) continue; // never fetched
  if (m.format === "REELS") {
    // Instagram gives reels reposts only; follows and profile visits are feed-only.
    details.ig[m.id] = { follows: null, profileVisits: null, reposts: int(0, 14), viewsSplit: null, fetchedAt: DETAILS_AT,
      missing: { follows: "unsupported", profileVisits: "unsupported", viewsSplit: "unsupported" } };
  } else {
    details.ig[m.id] = { follows: int(3, 40), profileVisits: int(40, 400), reposts: int(0, 6), viewsSplit: null, fetchedAt: DETAILS_AT,
      missing: { viewsSplit: "unsupported" } };
  }
}
const fresh = igMedia.find((m) => m.insightsPending);
details.ig[fresh.id] = { ...details.ig[fresh.id], reposts: null, missing: { ...details.ig[fresh.id].missing, reposts: "pending" } };
const secondFeed = feedPosts[1];
details.ig[secondFeed.id] = { ...details.ig[secondFeed.id], follows: null, missing: { ...details.ig[secondFeed.id].missing, follows: "unsupported" } };
const failing = igMedia.find((m) => m.format === "REELS" && !m.insightsPending && m.id !== fresh.id);
details.ig[failing.id] = { ...details.ig[failing.id], fetchedAt: iso(AS_OF - 20.5 * H),
  error: "ig media details: HTTP 500 An unexpected error has occurred.", errorAt: DETAILS_AT };
details.warnings.push(`ig post details: 1 post(s) failed: ${failing.id}: ig media details: HTTP 500 An unexpected error has occurred.`);

const longForm = dataset.youtube.videos.filter((v) => v.format === "videoOnDemand");
for (const v of dataset.youtube.videos) {
  if (v.id === longForm[longForm.length - 1].id) continue; // never fetched
  if (v.analyticsPending) {
    details.yt[v.id] = { engagedViews: null, analyticsViews: null, subscribedViews: null, unsubscribedViews: null, fetchedAt: DETAILS_AT,
      missing: { engagedViews: "pending", subscribedSplit: "pending" } };
    continue;
  }
  const views = Math.round(v.views * 0.97);
  const subscribed = Math.round(views * between(0.03, 0.08));
  details.yt[v.id] = { engagedViews: Math.round(views * between(0.35, 0.6)), analyticsViews: views, subscribedViews: subscribed,
    unsubscribedViews: views - subscribed, missing: {}, fetchedAt: DETAILS_AT };
}
const noEngaged = dataset.youtube.videos.find((v) => !v.analyticsPending && details.yt[v.id]);
details.yt[noEngaged.id] = { ...details.yt[noEngaged.id], engagedViews: null, analyticsViews: null, missing: { engagedViews: "unsupported" } };

// ---------------------------------------------------------------- write
const outDir = resolve(here, "../.local");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "sample.json"), JSON.stringify(dataset, null, 2));
writeFileSync(resolve(outDir, "details.json"), JSON.stringify(details, null, 2));
writeFileSync(resolve(outDir, "snapshots.json"), JSON.stringify({ asOf: dataset.generatedAt, blobs: Object.fromEntries(blobs) }));
console.log(
  `fixture written to .local/: ${dataset.youtube.videos.length} videos + ${dataset.instagram.media.length} Instagram posts, ` +
    `${dataset.daily.length} daily points, ${[...blobs.keys()].length} snapshot blobs (${[...blobs.keys()].join(", ")})`
);
