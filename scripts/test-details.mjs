/**
 * Logic test of post details, the Instagram daily cache and the new splits,
 * with every network call stubbed.
 *
 *   node scripts/test-details.mjs                      the checks below
 *   node scripts/test-details.mjs --timing 500         request counts and wall time per run,
 *                                                      every fake request taking 500 ms
 *   node scripts/test-details.mjs --compare <dir> [--timing 500]
 *                                                      the same refresh, run with the code in
 *                                                      <dir> (e.g. a worktree of another
 *                                                      branch), for a before/after count
 *
 * Nothing leaves this machine: graph.facebook.com, graph.instagram.com and the
 * Google APIs are a fake world answered in-process, Netlify Blobs is an
 * in-memory store, and the clock is faked. Needs Node 23.6+ (runs the .mts
 * functions directly by stripping their types).
 *
 * Checks that:
 *   1. a refresh with a cold cache asks Instagram exactly what it asked before
 *      (90 plain daily views, no split, no follows) and never writes the cache;
 *      YouTube's channel views by subscribedStatus per day are parsed and filled
 *   2. the background run backfills the cache: follow_type split parsed,
 *      follows_and_unfollows parsed into follows and unfollows
 *   3. a warm refresh requests only the last 3 days and reads the rest, the
 *      split and the follows from the cache; the Instagram follower
 *      reconstruction uses the real net (follows - unfollows)
 *   4. a second background run requests only the last 3 days of history, and
 *      only posts younger than 30 days (older ones keep their values)
 *   5. views breakdown rejected: the day is retried without it, one warning,
 *      no daily views lost; follow_type rejected but follower_type accepted
 *   6. a per-media metric rejected is dropped for the run (per surface), the
 *      others are still fetched, and the warning names it, whether or not the
 *      error message says which metric it was
 *   7. engagedViews rejected: the subscribed split still runs, and the
 *      refresh's video analytics never carries engagedViews
 *   8. one post failing does not stop the others, and keeps its old values
 *   9. relative retention is summarised per video
 *  10. /api/details returns the right post, null for an unknown id, 400 / 401
 *      as expected; details-background refuses a call without the key
 *  11. a hung cache read leaves a warning and a normal refresh
 */

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1] ?? "";
};
const TIMING = flag("--timing") !== null ? Number(flag("--timing") || 500) : 0;
const COMPARE = flag("--compare");

// ------------------------------------------------------------- fake blobs
const stores = new Map();
globalThis.__testBlobs = { stores, fail: null, ops: [] };
const BLOBS_STUB = `
  const t = globalThis.__testBlobs;
  function open(name) {
    if (!t.stores.has(name)) t.stores.set(name, new Map());
    const m = t.stores.get(name);
    const check = async (op, key) => {
      t.ops.push(op + " " + key);
      const f = t.fail;
      if (f && f.op === op && f.match.test(key)) {
        if (f.hang) await new Promise(() => {});
        throw new Error("blob store " + op + " " + key + " failed");
      }
    };
    return {
      async get(key, opts) {
        await check("get", key);
        if (!m.has(key)) return null;
        const v = m.get(key);
        return opts && opts.type === "json" ? structuredClone(v) : JSON.stringify(v);
      },
      async setJSON(key, value) { await check("set", key); m.set(key, structuredClone(value)); },
    };
  }
  export const getStore = (o) => open(typeof o === "string" ? o : o.name);
  export const getDeployStore = getStore;
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@netlify/blobs") {
      return { url: "data:text/javascript," + encodeURIComponent(BLOBS_STUB), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// Both platforms configured, as in production.
delete process.env.IG_USER_ID;
delete process.env.META_AUTH;
Object.assign(process.env, {
  META_ACCESS_TOKEN: "fake-meta-token",
  META_APP_ID: "fake-app",
  META_APP_SECRET: "fake-secret",
  GOOGLE_CLIENT_ID: "fake-client",
  GOOGLE_CLIENT_SECRET: "fake-secret",
  GOOGLE_REFRESH_TOKEN: "fake-refresh",
  DASH_KEY: "test-key",
});
delete process.env.DASH_TZ;

// ------------------------------------------------------------- fake clock
const RealDate = Date;
const DAY = 86400000;
const H = 3600000;
const NOW = RealDate.parse("2026-10-12T09:00:00Z");
let nowMs = NOW;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(nowMs);
    else super(...a);
  }
  static now() {
    return nowMs;
  }
}
globalThis.Date = FakeDate;
const isoDay = (ms) => new RealDate(ms).toISOString().slice(0, 10);
const daysAgo = (n, from = nowMs) => isoDay(from - n * DAY);

// ------------------------------------------------------------- fake world
const IG_ID = "17841400000000001";
const dayNum = (date) => Math.round(RealDate.parse(date + "T00:00:00Z") / DAY);
const W = {
  // Instagram: 55 reels and 5 feed posts inside the 2-year window, one every 6
  // days from 2 hours ago; 10 more older than 2 years that are filtered out.
  media: [],
  // Account daily figures, by date.
  views: (d) => 1000 + (dayNum(d) % 50) * 20,
  split: (d) => {
    const v = W.views(d);
    const follower = Math.round(v * 0.2);
    return { follower, nonFollower: v - follower - 10, unknown: 10 };
  },
  follows: (d) => 5 + (dayNum(d) % 7),
  unfollows: (d) => 1 + (dayNum(d) % 3),
  // knobs
  rejectViewsBreakdown: new Set(),
  rejectFollows: false,
  rejectMediaMetrics: {}, // surface -> Set(metric)
  opaqueRejection: false, // error message does not say which metric
  rejectMediaBreakdown: new Set(),
  failMedia: new Set(),
  rejectEngagedViews: false,
  // YouTube
  videos: [],
};
function buildWorld(at) {
  W.media = [];
  for (let i = 0; i < 70; i++) {
    const old = i >= 60;
    const t = old ? at - (800 + i) * DAY : i === 0 ? at - 2 * H : at - i * 6 * DAY;
    W.media.push({
      id: "1790000000" + String(i).padStart(7, "0"),
      shortcode: "SC" + i,
      ts: new RealDate(t).toISOString().replace(".000Z", "+0000"),
      product: i % 12 === 5 ? "FEED" : "REELS",
      views: i === 0 ? 500 : 2000 + i * 100,
      pending: i === 0,
      i,
    });
  }
  const ages = [1, 10, 20, 40, 60, 90, 200, 400, 15, 30];
  W.videos = ages.map((a, i) => ({
    id: "vid" + String(i).padStart(8, "0"),
    published: new RealDate(at - a * DAY).toISOString(),
    public: i < 8,
    lifetime: 400 + i * 150,
    // Inside YouTube's lag: analytics has nothing yet.
    pendingAnalytics: a < 3,
    i,
  }));
}
buildWorld(NOW);

// ------------------------------------------------------------- fake fetch
let log = [];
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (status, code, message) => json({ error: { message, type: "OAuthException", code } }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function categorize(url) {
  const p = url.searchParams;
  if (url.host === "graph.instagram.com") return "ig detect (instagram login probe)";
  if (url.host === "graph.facebook.com") {
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    if (path === "me/accounts") return "ig detect (me/accounts)";
    if (path === "debug_token") return "ig token inspect";
    if (path === IG_ID) return "ig profile";
    if (path === IG_ID + "/media") return "ig media list";
    if (path === IG_ID + "/insights") {
      const m = p.get("metric");
      if (m === "views") return p.get("breakdown") ? "ig daily views + split" : "ig daily views";
      if (m === "follows_and_unfollows") return "ig daily follows_and_unfollows";
      return "ig account " + m;
    }
    if (path.endsWith("/insights")) {
      const m = p.get("metric");
      if (m.startsWith("views,reach")) return "ig media insights (core)";
      if (m.startsWith("ig_reels")) return "ig media insights (reel extra)";
      if (m === "views" && p.get("breakdown")) return "ig media details (views split)";
      return "ig media details (metrics)";
    }
  }
  if (url.host === "oauth2.googleapis.com") return "yt token";
  if (url.host === "www.googleapis.com") return "yt data " + url.pathname.split("/").pop();
  if (url.host === "youtubeanalytics.googleapis.com") {
    const dims = p.get("dimensions");
    if (p.get("metrics") === "views,engagedViews") return "yt engagedViews (all videos)";
    if (dims === "subscribedStatus") return "yt video subscribedStatus";
    if (dims === "day,subscribedStatus") return "yt channel subscribedStatus per day";
    return "yt analytics " + dims;
  }
  return "other " + url.host;
}

function graphInsights(m, p) {
  const metric = p.get("metric");
  const breakdown = p.get("breakdown");
  const names = metric.split(",");
  const surface = m.product;
  const rejected = W.rejectMediaMetrics[surface] || new Set();
  const bad = names.findIndex((n) => rejected.has(n));
  if (bad >= 0) {
    return graphError(400, 100, W.opaqueRejection
      ? "(#100) An unknown error occurred with the requested insights"
      : `(#100) metric[${bad}] must be one of the following values: views, reach, saved, shares, total_interactions, ${names.filter((n) => !rejected.has(n)).join(", ")}`);
  }
  if (breakdown) {
    if (W.rejectMediaBreakdown.has(breakdown)) return graphError(400, 100, "(#100) Incompatible breakdowns for the requested metric");
    const f = m.pending ? 0 : Math.round(m.views * 0.15);
    const u = m.pending ? 0 : 5;
    return json({ data: [{ name: "views", period: "lifetime", total_value: { value: m.pending ? 0 : m.views,
      breakdowns: [{ dimension_keys: [breakdown], results: [
        { dimension_values: ["FOLLOWER"], value: f },
        { dimension_values: ["NON_FOLLOWER"], value: m.pending ? 0 : m.views - f - u },
        { dimension_values: ["UNKNOWN"], value: u },
      ] }] } }] });
  }
  const value = (n) => {
    if (m.pending && n !== "views") return 0;
    switch (n) {
      case "views": return m.views;
      case "reach": return Math.round(m.views * 0.8);
      case "saved": return 10 + m.i;
      case "shares": return 3;
      case "total_interactions": return 40;
      case "ig_reels_avg_watch_time": return 9000;
      case "ig_reels_video_view_total_time": return 9000 * m.views;
      case "reels_skip_rate": return 50;
      case "follows": return 3 + (m.i % 5);
      case "profile_visits": return 20 + m.i;
      case "reposts": return m.i % 4;
      default: return 0;
    }
  };
  return json({ data: names.map((n) => ({ name: n, period: "lifetime", values: [{ value: value(n) }] })) });
}

function accountInsights(p) {
  const metric = p.get("metric");
  const since = p.get("since");
  if (metric === "reach") {
    const out = [];
    for (let t = RealDate.parse(since + "T00:00:00Z"); isoDay(t) < p.get("until"); t += DAY) {
      out.push({ value: 500, end_time: isoDay(t) + "T07:00:00+0000" });
    }
    return json({ data: [{ name: "reach", period: "day", values: out }] });
  }
  if (metric === "views") {
    const b = p.get("breakdown");
    if (b && W.rejectViewsBreakdown.has(b)) return graphError(400, 100, "(#100) Incompatible breakdowns for metric views");
    const tv = { value: W.views(since) };
    if (b) {
      const s = W.split(since);
      tv.breakdowns = [{ dimension_keys: [b], results: [
        { dimension_values: ["FOLLOWER"], value: s.follower },
        { dimension_values: ["NON_FOLLOWER"], value: s.nonFollower },
        { dimension_values: ["UNKNOWN"], value: s.unknown },
      ] }];
    }
    return json({ data: [{ name: "views", period: "day", total_value: tv }] });
  }
  if (metric === "follows_and_unfollows") {
    if (W.rejectFollows) return graphError(400, 100, "(#100) follows_and_unfollows is not available for this account");
    return json({ data: [{ name: "follows_and_unfollows", period: "day", total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [
      { dimension_values: ["FOLLOWER"], value: W.follows(since) },
      { dimension_values: ["NON_FOLLOWER"], value: W.unfollows(since) },
    ] }] } }] });
  }
  if (metric === "follower_count") {
    const out = [];
    for (let t = RealDate.parse(since + "T00:00:00Z"); isoDay(t) <= p.get("until"); t += DAY) {
      out.push({ value: W.follows(isoDay(t)) + 2, end_time: isoDay(t) + "T07:00:00+0000" });
    }
    return json({ data: [{ name: "follower_count", period: "day", values: out }] });
  }
  if (metric === "follower_demographics") {
    const keys = { country: ["GB", "US"], age: ["25-34", "35-44"], gender: ["M", "F", "U"] }[p.get("breakdown")] || [];
    return json({ data: [{ name: "follower_demographics", total_value: { breakdowns: [{ dimension_keys: [p.get("breakdown")],
      results: keys.map((k, i) => ({ dimension_values: [k], value: 300 - i * 100 })) }] } }] });
  }
  return graphError(400, 100, "(#100) unknown metric " + metric);
}

function graph(url) {
  const p = url.searchParams;
  if (url.host === "graph.instagram.com") return graphError(400, 190, "Invalid OAuth access token - Cannot parse access token");
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
  if (path === "me/accounts") return json({ data: [{ id: "page1", name: "Page", instagram_business_account: { id: IG_ID, username: "test" } }] });
  if (path === "debug_token") return json({ data: { expires_at: Math.round((nowMs + 50 * DAY) / 1000) } });
  if (path === IG_ID) return json({ username: "test", name: "Test", followers_count: 5000, follows_count: 300, media_count: 70 });
  if (path === IG_ID + "/media") {
    const start = p.get("after") ? Number(p.get("after")) : 0;
    const page = W.media.slice(start, start + 50).map((m) => ({
      id: m.id, shortcode: m.shortcode, caption: "Post " + m.i, media_type: m.product === "FEED" ? "CAROUSEL_ALBUM" : "VIDEO",
      media_product_type: m.product, permalink: "https://example.com/instagram/" + m.shortcode, timestamp: m.ts,
      like_count: 50, comments_count: 5,
    }));
    const more = start + 50 < W.media.length;
    return json({ data: page, paging: more ? { next: "x", cursors: { after: String(start + 50) } } : {} });
  }
  if (path === IG_ID + "/insights") return accountInsights(p);
  const id = path.split("/")[0];
  const m = W.media.find((x) => x.id === id);
  if (m && path.endsWith("/insights")) {
    if (W.failMedia.has(id)) return graphError(500, 2, "An unexpected error has occurred. Please retry your request later.");
    return graphInsights(m, p);
  }
  return graphError(400, 100, "(#100) Unsupported get request: " + path);
}

function rows(headers, data) {
  return json({ columnHeaders: headers.map((name) => ({ name })), rows: data });
}

function analytics(p) {
  const dims = p.get("dimensions") || "";
  const metrics = p.get("metrics");
  const filter = (p.get("filters") || "").replace("video==", "");
  const v = W.videos.find((x) => x.id === filter);
  const lastDay = daysAgo(3);
  const days = [];
  for (let i = 90; i >= 3; i--) days.push(daysAgo(i));
  const aViews = (x) => (x.pendingAnalytics ? 0 : x.lifetime - 20);
  if (metrics === "views,engagedViews") {
    if (W.rejectEngagedViews) return json({ error: { code: 400, message: "Unknown identifier (engagedViews) given in field parameters.metrics." } }, 400);
    return rows(["video", "views", "engagedViews"], W.videos.filter((x) => !x.pendingAnalytics).map((x) => [x.id, aViews(x), Math.round(aViews(x) * 0.4)]));
  }
  if (dims === "video") {
    assert.ok(!metrics.includes("engagedViews"), "the refresh's video analytics query must never carry engagedViews");
    return rows(["video", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "likes", "comments", "shares", "subscribersGained"],
      W.videos.filter((x) => !x.pendingAnalytics).map((x) => [x.id, aViews(x), 100, 30, 70 + x.i, 10, 2, 1, x.i]));
  }
  if (dims === "creatorContentType") return rows(["creatorContentType", "views"], [["shorts", 100]]);
  if (dims === "subscribedStatus") {
    if (!v || v.pendingAnalytics) return rows(["subscribedStatus", "views"], []);
    return rows(["subscribedStatus", "views"], [["SUBSCRIBED", Math.round(aViews(v) * 0.1)], ["UNSUBSCRIBED", aViews(v) - Math.round(aViews(v) * 0.1)]]);
  }
  if (dims === "day,subscribedStatus") {
    // Quiet days are omitted, as the API does; days ending in 0 have no views.
    return rows(["day", "subscribedStatus", "views"], days.filter((d) => !d.endsWith("0"))
      .flatMap((d) => [[d, "SUBSCRIBED", 5], [d, "UNSUBSCRIBED", 45]]));
  }
  if (dims === "day" && metrics.startsWith("views")) return rows(["day", "views", "estimatedMinutesWatched", "likes", "comments", "shares"], days.filter((d) => !d.endsWith("0")).map((d) => [d, 50, 10, 1, 0, 0]));
  if (dims === "day") return rows(["day", "subscribersGained", "subscribersLost"], [[lastDay, 3, 1]]);
  if (dims === "day,insightTrafficSourceType") return rows(["day", "insightTrafficSourceType", "views", "estimatedMinutesWatched"], [[lastDay, "SHORTS", 40, 8]]);
  if (dims === "country") return rows(["country", "views", "estimatedMinutesWatched"], [["GB", 30, 5]]);
  if (dims === "ageGroup") return rows(["ageGroup", "viewerPercentage"], [["age25-34", 60], ["age35-44", 40]]);
  if (dims === "gender") return rows(["gender", "viewerPercentage"], [["male", 80], ["female", 20]]);
  if (dims === "elapsedVideoTimeRatio") {
    return rows(["elapsedVideoTimeRatio", "audienceWatchRatio", "relativeRetentionPerformance"],
      Array.from({ length: 11 }, (_, i) => [i / 10, 1 - i * 0.05, v.i % 2 ? 0.4 + i * 0.01 : 0.6 + i * 0.01]));
  }
  return json({ error: { code: 400, message: "unexpected query " + dims + " " + metrics } }, 400);
}

function google(url) {
  if (url.host === "oauth2.googleapis.com") return json({ access_token: "fake-google-access", expires_in: 3600 });
  if (url.host === "www.googleapis.com") {
    const what = url.pathname.split("/").pop();
    if (what === "channels") return json({ items: [{ id: "UC1", snippet: { title: "Test", thumbnails: {} },
      statistics: { subscriberCount: "500", videoCount: "10", viewCount: "20000" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
    if (what === "playlistItems") return json({ items: W.videos.map((v) => ({ contentDetails: { videoId: v.id } })) });
    if (what === "videos") {
      const ids = url.searchParams.get("id").split(",");
      return json({ items: W.videos.filter((v) => ids.includes(v.id)).map((v) => ({
        id: v.id, snippet: { title: "Video " + v.i, publishedAt: v.published, thumbnails: {} }, contentDetails: { duration: "PT45S" },
        statistics: { viewCount: String(v.lifetime), likeCount: "10", commentCount: "2" }, status: { privacyStatus: v.public ? "public" : "private" },
      })) });
    }
  }
  if (url.host === "youtubeanalytics.googleapis.com") return analytics(url.searchParams);
  return json({ error: "unexpected" }, 404);
}

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  log.push({ url, cat: categorize(url) });
  if (TIMING) await sleep(TIMING);
  if (url.host.startsWith("graph.")) return graph(url);
  if (url.host.endsWith("googleapis.com")) return google(url);
  throw new Error("unexpected network call to " + url.host);
};

// ------------------------------------------------------------- helpers
const passed = [];
const ok = (msg) => {
  passed.push(msg);
  console.log("  ok  " + msg);
};
const count = (entries, pred) => entries.filter(pred).length;
function tally(entries) {
  const by = {};
  for (const e of entries) by[e.cat] = (by[e.cat] || 0) + 1;
  return by;
}
function summary(entries) {
  const ig = count(entries, (e) => e.cat.startsWith("ig"));
  const yt = count(entries, (e) => e.cat.startsWith("yt"));
  return { total: entries.length, instagram: ig, youtube: yt };
}
const blobs = () => stores.get("social-dashboard") || new Map();

async function loadCode(root) {
  const base = pathToFileURL(resolve(root) + "/").href;
  return {
    refresh: await import(new URL("netlify/lib/refresh.mjs", base)),
    details: await import(new URL("netlify/lib/details.mjs", base)).catch(() => null),
  };
}

async function run(fn) {
  log = [];
  globalThis.__testBlobs.ops = [];
  const t0 = RealDate.now();
  const result = await fn();
  return { result, entries: log, ms: RealDate.now() - t0, ops: globalThis.__testBlobs.ops.slice() };
}

function printCounts(label, r) {
  const s = summary(r.entries);
  console.log(`\n  ${label}: ${s.total} requests (Instagram ${s.instagram}, YouTube ${s.youtube})` +
    (TIMING ? `, ${(r.ms / 1000).toFixed(1)} s at ${TIMING} ms per request` : ""));
  for (const [cat, n] of Object.entries(tally(r.entries)).sort()) console.log(`      ${String(n).padStart(4)}  ${cat}`);
}

// ================================================================ compare mode
if (COMPARE) {
  const { refresh } = await loadCode(COMPARE);
  console.log(`Refresh with the code in ${COMPARE}, same fake world`);
  const r = await run(() => refresh.doRefresh());
  printCounts("refresh", r);
  process.exit(0);
}

const here = resolve(new URL(".", import.meta.url).pathname, "..");
const { refresh, details } = await loadCode(here);
const { doRefresh, LATEST_KEY } = refresh;
const { runDetails, DETAILS_KEY } = details;
const { default: detailsHandler } = await import(pathToFileURL(here + "/netlify/functions/details.mts").href);
const { default: backgroundHandler } = await import(pathToFileURL(here + "/netlify/functions/details-background.mts").href);
const igDailyKeys = () => [...blobs().keys()].filter((k) => k.startsWith("ig-daily/")).sort();
const igDailyDays = () => {
  const out = new Map();
  for (const k of igDailyKeys()) for (const [d, r] of Object.entries(blobs().get(k).days)) out.set(d, r);
  return out;
};

// ================================================================ timing mode
if (TIMING) {
  console.log(`Request counts and wall time, every fake request taking ${TIMING} ms`);
  printCounts("refresh, cold cache (first refresh after deploy)", await run(() => doRefresh()));
  printCounts("details background, cold cache", await run(() => runDetails(storeOf())));
  nowMs += 3 * H;
  printCounts("refresh, warm cache (steady state)", await run(() => doRefresh()));
  nowMs += 3 * H;
  printCounts("details background, warm (steady state)", await run(() => runDetails(storeOf())));
  process.exit(0);
}
function storeOf() {
  return refresh.store();
}

// ================================================================ 1. cold refresh
console.log("\nRefresh before the background function has ever run (cold cache)");
const window90 = Array.from({ length: 90 }, (_, i) => daysAgo(90 - i));
const cold = await run(() => doRefresh());
{
  const views = cold.entries.filter((e) => e.cat === "ig daily views");
  assert.equal(views.length, 90);
  assert.deepEqual(views.map((e) => e.url.searchParams.get("since")).sort(), window90);
  assert.equal(count(cold.entries, (e) => e.url.searchParams.get("breakdown") && e.cat.startsWith("ig daily")), 0);
  assert.equal(count(cold.entries, (e) => e.cat.includes("follows_and_unfollows") || e.cat.startsWith("ig media details")), 0);
  ok("Instagram: 90 plain daily views requests, no breakdown, no follows_and_unfollows, no per-media details");
  assert.ok(!cold.ops.some((o) => o.startsWith("set ig-daily")), "the refresh never writes the cache");
  assert.equal(cold.ops.filter((o) => o.startsWith("get ig-daily")).length, 4, "90 days touch four months");
  ok(`reads the cache (${cold.ops.filter((o) => o.startsWith("get ig-daily")).join(", ")}) and never writes it`);
  const ds = cold.result;
  assert.deepEqual(ds.warnings, []);
  const igDays = ds.daily.filter((p) => p.instagram !== null);
  assert.equal(igDays.length, 90);
  assert.ok(igDays.every((p) => p.igViewsFollower === null && p.igFollows === null));
  ok("no split or follows yet: those fields are null, not zero");
  const yt = ds.daily.filter((p) => p.ytViewsSubscribed !== null);
  assert.equal(yt[0].date, daysAgo(90));
  assert.equal(yt[yt.length - 1].date, daysAgo(3), "stops at YouTube's last reported day, never padded into the lag");
  const quiet = yt.find((p) => p.date.endsWith("0"));
  assert.deepEqual([quiet.ytViewsSubscribed, quiet.ytViewsUnsubscribed], [0, 0], "a day the API omitted is a real zero");
  const busy = yt.find((p) => !p.date.endsWith("0"));
  assert.deepEqual([busy.ytViewsSubscribed, busy.ytViewsUnsubscribed], [5, 45]);
  assert.equal(count(cold.entries, (e) => e.cat === "yt channel subscribedStatus per day"), 1);
  ok(`YouTube channel views by subscribedStatus per day: one request, ${yt.length} days through ${daysAgo(3)}, quiet days filled with 0`);
  printCounts("refresh, cold cache", cold);
}

// ================================================================ 2. background, cold
console.log("\nDetails background function, first run (cold cache)");
nowMs = NOW + 30 * 60000;
const bg1 = await run(() => runDetails(storeOf()));
{
  const out = bg1.result;
  assert.deepEqual(out.warnings, []);
  const tl = tally(bg1.entries);
  assert.equal(tl["ig daily views + split"], 90);
  assert.equal(tl["ig daily follows_and_unfollows"], 90);
  assert.equal(tl["ig daily views"] || 0, 0);
  ok("backfills all 90 days: 90 views+split and 90 follows_and_unfollows requests");
  const days = igDailyDays();
  assert.equal(days.size, 90);
  const d = daysAgo(40);
  assert.deepEqual(days.get(d).viewsSplit, W.split(d));
  assert.equal(days.get(d).views, W.views(d));
  ok(`follow_type split parsed: ${d} -> ${JSON.stringify(days.get(d).viewsSplit)} of ${days.get(d).views}`);
  assert.deepEqual([days.get(d).follows, days.get(d).unfollows], [W.follows(d), W.unfollows(d)]);
  ok(`follows_and_unfollows parsed: ${d} -> ${W.follows(d)} follows, ${W.unfollows(d)} unfollows`);
  assert.deepEqual(igDailyKeys(), ["ig-daily/2026-07", "ig-daily/2026-08", "ig-daily/2026-09", "ig-daily/2026-10"]);
  // Per post
  const inWindow = W.media.filter((m) => m.i < 60);
  assert.equal(Object.keys(out.ig).length, 60, "the 10 posts older than 2 years are left out");
  assert.equal(tl["ig media details (metrics)"], 60);
  assert.equal(tl["ig media details (views split)"] || 0, 0);
  const reel = inWindow[7];
  assert.deepEqual(
    [out.ig[reel.id].follows, out.ig[reel.id].profileVisits, out.ig[reel.id].reposts, out.ig[reel.id].viewsSplit],
    [null, null, 7 % 4, null]
  );
  assert.deepEqual(out.ig[reel.id].missing, { follows: "unsupported", profileVisits: "unsupported", viewsSplit: "unsupported" });
  const feedPost = inWindow.find((m) => m.product === "FEED" && !m.pending);
  assert.deepEqual(
    [out.ig[feedPost.id].follows, out.ig[feedPost.id].profileVisits, out.ig[feedPost.id].reposts],
    [3 + (feedPost.i % 5), 20 + feedPost.i, feedPost.i % 4]
  );
  ok("per post, one request each: reels ask for reposts only, feed posts for follows, profile_visits and reposts; no views split");
  const fresh = out.ig[W.media[0].id];
  assert.deepEqual(fresh.missing, { follows: "unsupported", profileVisits: "unsupported", reposts: "pending", viewsSplit: "unsupported" });
  ok("a post published 2 hours ago reports zeros: stored as pending, not as 0");
  assert.equal(Object.keys(out.yt).length, 8, "public videos only");
  assert.equal(tl["yt engagedViews (all videos)"], 1);
  assert.equal(tl["yt video subscribedStatus"], 8);
  const v = W.videos[3];
  assert.deepEqual(out.yt[v.id], { engagedViews: Math.round((v.lifetime - 20) * 0.4), analyticsViews: v.lifetime - 20,
    subscribedViews: Math.round((v.lifetime - 20) * 0.1), unsubscribedViews: v.lifetime - 20 - Math.round((v.lifetime - 20) * 0.1),
    missing: {}, fetchedAt: new RealDate(nowMs).toISOString() });
  ok("per video: engagedViews for all videos in one query, views by subscribedStatus per video");
  assert.deepEqual(out.yt[W.videos[0].id].missing, { engagedViews: "pending", subscribedSplit: "pending" });
  ok("a video inside YouTube's lag is pending, not 0");
  printCounts("details background, cold cache", bg1);
}

// ================================================================ 3. warm refresh
console.log("\nRefresh after the background run (warm cache)");
nowMs = NOW + 3 * H;
const warm = await run(() => doRefresh());
{
  const views = warm.entries.filter((e) => e.cat.startsWith("ig daily"));
  assert.deepEqual(views.map((e) => e.url.searchParams.get("since")).sort(), [daysAgo(3), daysAgo(2), daysAgo(1)]);
  assert.ok(views.every((e) => e.cat === "ig daily views"));
  ok("requests only the last 3 days of views, plain; the other 87 come from the cache");
  const ds = warm.result;
  assert.deepEqual(ds.warnings, []);
  const d = daysAgo(40);
  const p = ds.daily.find((x) => x.date === d);
  assert.deepEqual([p.instagram, p.igViewsFollower, p.igViewsNonFollower, p.igViewsUnknown], [W.views(d), W.split(d).follower, W.split(d).nonFollower, W.split(d).unknown]);
  assert.deepEqual([p.igFollows, p.igUnfollows], [W.follows(d), W.unfollows(d)]);
  ok("daily series carries the split and follows/unfollows from the cache");
  // Reconstruction: consecutive levels differ by the real net.
  const h = ds.derivedHistory.filter((x) => x.instagram !== null);
  assert.equal(h[0].date, daysAgo(90), "the true net reaches back the full 90 days");
  const i = h.findIndex((x) => x.date === d);
  assert.equal(h[i].instagram - h[i - 1].instagram, W.follows(d) - W.unfollows(d));
  assert.equal(h[h.length - 1].instagram, 5000);
  ok(`Instagram follower reconstruction walks back through follows - unfollows (${d}: +${W.follows(d) - W.unfollows(d)}), not gross adds (+${W.follows(d) + 2})`);
  const ret = ds.youtube.retention;
  assert.equal(ret.length, 8);
  const r1 = ret.find((r) => r.video === W.videos[1].id);
  const r2 = ret.find((r) => r.video === W.videos[2].id);
  assert.ok(Math.abs(r1.relativeAvg - 0.45) < 1e-9 && Math.abs(r2.relativeAvg - 0.65) < 1e-9);
  ok(`relative retention summarised per video: ${r1.relativeAvg.toFixed(2)} (below typical 0.5), ${r2.relativeAvg.toFixed(2)} (above)`);
  printCounts("refresh, warm cache (steady state)", warm);
  const cs = summary(cold.entries), ws = summary(warm.entries);
  console.log(`\n  steady state: ${ws.total} requests per refresh against ${cs.total} with a cold cache (Instagram ${ws.instagram} vs ${cs.instagram})`);
}

// ================================================================ 4. background, warm
console.log("\nDetails background function, second run 6 hours later, then the next day");
nowMs = NOW + 6 * H + 30 * 60000;
const bg2 = await run(() => runDetails(storeOf()));
{
  const tl = tally(bg2.entries);
  const sinces = (cat) => bg2.entries.filter((e) => e.cat === cat).map((e) => e.url.searchParams.get("since")).sort();
  assert.deepEqual(sinces("ig daily views + split"), [daysAgo(3), daysAgo(2), daysAgo(1)]);
  assert.deepEqual(sinces("ig daily follows_and_unfollows"), [daysAgo(3), daysAgo(2), daysAgo(1)]);
  ok("history: only the last 3 days of views+split and follows_and_unfollows");
  const recent = W.media.filter((m) => m.i < 60 && nowMs - RealDate.parse(m.ts.replace("+0000", "Z")) <= 30 * DAY).length;
  assert.equal(recent, 5);
  assert.equal(tl["ig media details (metrics)"], recent);
  assert.equal(bg2.result.counts.instagram.kept, 55);
  const oldId = W.media[20].id;
  assert.equal(bg2.result.ig[oldId].fetchedAt, bg1.result.ig[oldId].fetchedAt, "kept with its first fetch time");
  ok(`posts: ${recent} younger than 30 days re-fetched, 55 older ones kept from the last run without a request`);
  assert.equal(tl["yt video subscribedStatus"], 3, "videos 1, 10 and 20 days old");
  assert.equal(tl["yt engagedViews (all videos)"], 1);
  const oldVideo = W.videos[6]; // 200 days old: kept, but its engaged views come from this run's query
  assert.equal(bg2.result.yt[oldVideo.id].fetchedAt, bg1.result.yt[oldVideo.id].fetchedAt);
  assert.equal(bg2.result.yt[oldVideo.id].engagedViews, Math.round((oldVideo.lifetime - 20) * 0.4));
  ok("videos: 3 younger than 30 days re-fetched; engagedViews stays one query for all, older videos take its fresh figure");
  printCounts("details background, warm (steady state)", bg2);

  nowMs = NOW + DAY + 30 * 60000;
  const bg3 = await run(() => runDetails(storeOf()));
  const s3 = bg3.entries.filter((e) => e.cat === "ig daily views + split").map((e) => e.url.searchParams.get("since")).sort();
  assert.deepEqual(s3, [daysAgo(3), daysAgo(2), daysAgo(1)]);
  ok(`next day: still 3 days (${s3.join(", ")}); ${daysAgo(4)} is now final and read from the cache`);
  nowMs = NOW + DAY + 3 * H;
  const warm2 = await run(() => doRefresh());
  assert.equal(count(warm2.entries, (e) => e.cat === "ig daily views"), 3);
  ok("the next day's refresh also requests 3 days");
}

// ================================================================ 5. breakdown rejected
console.log("\nViews breakdown rejected");
async function freshBackground(setup) {
  stores.clear();
  nowMs = NOW;
  buildWorld(NOW);
  setup();
  await doRefresh(); // a dataset to take the post lists from
  nowMs = NOW + 30 * 60000;
  return run(() => runDetails(storeOf()));
}
{
  const r = await freshBackground(() => { W.rejectViewsBreakdown = new Set(["follow_type", "follower_type"]); });
  const warns = r.result.warnings.filter((w) => w.startsWith("ig views split"));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /rejected breakdown=follow_type and breakdown=follower_type/);
  const days = igDailyDays();
  assert.equal([...days.values()].filter((d) => d.views !== undefined).length, 90);
  assert.ok(window90.every((d) => days.get(d).views === W.views(d) && days.get(d).viewsSplit === null));
  const tl = tally(r.entries);
  assert.ok(tl["ig daily views + split"] <= 16, "stops asking once rejected (at most the 8 in flight, twice)");
  ok(`one warning ("${warns[0].slice(0, 90)}…"), all 90 days of views kept, ${tl["ig daily views + split"]} split attempts before it stopped`);

  const r2 = await freshBackground(() => { W.rejectViewsBreakdown = new Set(["follow_type"]); });
  const days2 = igDailyDays();
  assert.ok(window90.every((d) => JSON.stringify(days2.get(d).viewsSplit) === JSON.stringify(W.split(d))));
  assert.equal(r2.result.igDaily.splitBreakdown, "follower_type");
  assert.ok(r2.result.warnings.some((w) => /used breakdown=follower_type instead/.test(w)));
  ok("follow_type rejected, follower_type accepted: every day still gets its split, the warning says which was used");

  const r3 = await freshBackground(() => { W.rejectViewsBreakdown = new Set(); W.rejectFollows = true; });
  assert.equal(r3.result.warnings.filter((w) => w.startsWith("ig follows")).length, 1);
  assert.ok(count(r3.entries, (e) => e.cat === "ig daily follows_and_unfollows") <= 8);
  assert.ok(window90.every((d) => igDailyDays().get(d).follows === undefined));
  ok("follows_and_unfollows rejected: one warning, stops after the requests in flight, nothing stored as 0");
  W.rejectFollows = false;
}

// ================================================================ 6. per-media metric rejected
console.log("\nPer-media metric rejected");
{
  const r = await freshBackground(() => { W.rejectMediaMetrics = { FEED: new Set(["follows"]) }; });
  const out = r.result;
  const reels = W.media.filter((m) => m.i < 60 && m.product === "REELS" && !m.pending);
  const feed = W.media.filter((m) => m.i < 60 && m.product === "FEED");
  assert.ok(feed.every((m) => out.ig[m.id].follows === null && out.ig[m.id].missing.follows === "unsupported"));
  assert.ok(feed.every((m) => out.ig[m.id].profileVisits === 20 + m.i && out.ig[m.id].reposts === m.i % 4));
  assert.ok(reels.every((m) => out.ig[m.id].reposts === m.i % 4), "reels still get reposts");
  const w = out.warnings.filter((x) => x.startsWith("ig post details"));
  assert.equal(w.length, 1);
  assert.match(w[0], /feed: follows/);
  const metricCalls = count(r.entries, (e) => e.cat === "ig media details (metrics)");
  assert.ok(metricCalls <= 60 + 8, `dropped for the run: ${metricCalls} metric calls for 60 posts`);
  ok(`follows rejected for feed posts (message names metric[0]): dropped for the run, profile_visits and reposts still fetched, reels unaffected, ${metricCalls} metric calls for 60 posts`);
  ok(`warning: "${w[0]}"`);

  const r2 = await freshBackground(() => {
    W.rejectMediaMetrics = { FEED: new Set(["profile_visits"]) };
    W.opaqueRejection = true;
  });
  const out2 = r2.result;
  assert.ok(W.media.filter((m) => m.i < 60 && !m.pending && m.product === "FEED").every((m) =>
    out2.ig[m.id].profileVisits === null && out2.ig[m.id].missing.profileVisits === "unsupported" &&
    out2.ig[m.id].follows === 3 + (m.i % 5) && out2.ig[m.id].reposts === m.i % 4));
  assert.ok(W.media.filter((m) => m.i < 60 && !m.pending && m.product === "REELS").every((m) => out2.ig[m.id].reposts === m.i % 4));
  assert.match(out2.warnings.find((x) => x.startsWith("ig post details")), /profile_visits/);
  ok("an error that does not say which metric: each is asked alone once, the rejected one dropped, the others kept");
  W.opaqueRejection = false;

  const r3 = await freshBackground(() => {
    W.rejectMediaMetrics = {};
    W.rejectMediaBreakdown = new Set(["follow_type", "follower_type"]);
  });
  const out3 = r3.result;
  const sample = W.media[9];
  assert.equal(out3.ig[sample.id].missing.viewsSplit, "unsupported");
  assert.equal(out3.ig[sample.id].reposts, 9 % 4);
  assert.equal(count(r3.entries, (e) => e.cat === "ig media details (views split)"), 0);
  ok("views by follow type on media is not requested at all (Meta does not document it); the metrics call unaffected");
  W.rejectMediaBreakdown = new Set();
}

// ================================================================ 7. engagedViews rejected
console.log("\nengagedViews rejected");
{
  const r = await freshBackground(() => { W.rejectEngagedViews = true; });
  const out = r.result;
  const v = W.videos[4];
  assert.equal(out.yt[v.id].engagedViews, null);
  assert.equal(out.yt[v.id].missing.engagedViews, "unsupported");
  assert.equal(out.yt[v.id].subscribedViews, Math.round((v.lifetime - 20) * 0.1));
  assert.ok(out.warnings.some((w) => w.startsWith("yt engaged views")));
  ok("engagedViews rejected: marked unsupported with one warning, the per-video subscribed split still fetched");
  const latest = blobs().get(LATEST_KEY);
  const video = latest.youtube.videos.find((x) => x.id === v.id);
  assert.deepEqual([video.views, video.avgViewPercent, video.followsGained], [v.lifetime, 70 + v.i, v.i]);
  ok("the refresh's video analytics are untouched (and the fake API asserts engagedViews never reaches that query)");
  W.rejectEngagedViews = false;
}

// ================================================================ 8. one post fails
console.log("\nOne post failing");
{
  const r = await freshBackground(() => {});
  const failing = W.media[3].id; // 18 days old, so re-fetched each run
  const before = r.result.ig[failing];
  W.failMedia = new Set([failing]);
  nowMs = NOW + 7 * H;
  const r2 = await run(() => runDetails(storeOf()));
  const out = r2.result;
  assert.match(out.ig[failing].error, /HTTP 500/);
  assert.equal(out.ig[failing].follows, before.follows, "keeps the previous values");
  assert.equal(out.ig[failing].fetchedAt, before.fetchedAt, "and says when they were fetched");
  assert.equal(out.counts.instagram.failed, 1);
  assert.equal(out.counts.instagram.fetched, 4);
  assert.ok(out.warnings.some((w) => w.startsWith("ig post details: 1 post(s) failed") && w.includes(failing)));
  ok("a post whose insights fail: error recorded with its previous values, the other 4 recent posts fetched, one warning");
  W.failMedia = new Set();
  nowMs = NOW + 13 * H;
  const r3 = await run(() => runDetails(storeOf()));
  assert.equal(r3.result.ig[failing].error, undefined);
  ok("next run retries it and clears the error");
}

// ================================================================ 10. endpoint
console.log("\n/api/details and the background function's gate");
{
  const api = async (q, key = "test-key") => {
    const res = await detailsHandler(new Request("https://dash.test/api/details" + q, { headers: key ? { "x-dash-key": key } : {} }), {});
    return { status: res.status, body: await res.json() };
  };
  const reel = W.media[7];
  const a = await api(`?platform=instagram&id=${reel.id}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.id, reel.id);
  assert.equal(a.body.details.reposts, 7 % 4);
  assert.equal(a.body.generatedAt, blobs().get(DETAILS_KEY).generatedAt);
  const v = await api(`?platform=youtube&id=${W.videos[3].id}`);
  assert.equal(v.body.details.subscribedViews, Math.round((W.videos[3].lifetime - 20) * 0.1));
  ok("returns that post's record and when the details were generated");
  const none = await api("?platform=instagram&id=99999");
  assert.equal(none.status, 200);
  assert.equal(none.body.details, null);
  const cross = await api(`?platform=youtube&id=${reel.id}`);
  assert.equal(cross.body.details, null);
  ok("unknown id (or an Instagram id asked as YouTube): 200 with details null");
  assert.equal((await api("?platform=tiktok&id=1")).status, 400);
  assert.equal((await api("?platform=instagram&id=../x")).status, 400);
  assert.equal((await api(`?platform=instagram&id=${reel.id}`, null)).status, 401);
  ok("bad platform or id: 400; no key: 401");

  const before = blobs().get(DETAILS_KEY).generatedAt;
  nowMs = NOW + 20 * H;
  await backgroundHandler(new Request("https://dash.test/.netlify/functions/details-background", { method: "POST" }), {});
  assert.equal(blobs().get(DETAILS_KEY).generatedAt, before);
  await backgroundHandler(new Request("https://dash.test/.netlify/functions/details-background", { method: "POST", headers: { "x-dash-key": "test-key" } }), {});
  assert.equal(blobs().get(DETAILS_KEY).generatedAt, new RealDate(nowMs).toISOString());
  ok("details-background does nothing without the key, runs with it");
}

// ================================================================ 11. hung cache
console.log("\nCache read failures never fail the refresh");
{
  globalThis.__testBlobs.fail = { op: "get", match: /^ig-daily\//, hang: true };
  nowMs = NOW + 21 * H;
  const t0 = RealDate.now();
  const r = await run(() => doRefresh());
  assert.ok(r.result.warnings.includes("ig daily cache: read timed out after 3000ms"));
  assert.equal(count(r.entries, (e) => e.cat === "ig daily views"), 90, "falls back to requesting every day");
  assert.ok(RealDate.now() - t0 < 6000);
  ok(`hung cache read: warning after 3 s, all 90 days requested as before, refresh completed in ${((RealDate.now() - t0) / 1000).toFixed(1)} s`);
  globalThis.__testBlobs.fail = { op: "get", match: /^ig-daily\// };
  const r2 = await run(() => doRefresh());
  assert.ok(r2.result.warnings.some((w) => w.startsWith("ig daily cache: blob store get ig-daily/")));
  ok("failing cache read: warning, refresh completed");
  globalThis.__testBlobs.fail = null;
}

console.log(`\nall ${passed.length} checks passed`);
