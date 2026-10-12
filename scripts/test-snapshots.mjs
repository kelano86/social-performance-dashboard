/**
 * Logic test of the view snapshots, with every network call stubbed.
 *
 *   node scripts/test-snapshots.mjs
 *
 * Nothing leaves this machine: Netlify Blobs is an in-memory store, the
 * Instagram Graph API and the YouTube APIs are a fake world answered
 * in-process by a stubbed fetch, and the clock is faked so refreshes can be
 * spread over days. Needs Node 23.6+ (or 22.18+), which runs the .mts function
 * directly by stripping its types.
 *
 * Days are counted in DASH_TZ, set here to a fixed UTC+4 offset with no
 * daylight saving, so a local day runs 20:00Z to 20:00Z.
 *
 * Checks that:
 *   1. 12 refreshes over 36 h across a month boundary give the right 24 h gains
 *      and ordering, measured against the snapshot nearest to 24 h ago
 *   2. a reel published 5 h ago counts its full total; an old post missing from
 *      the baseline is null; a count revised down is clamped to 0 and counted
 *   3. a manual refresh 25 minutes after a scheduled one replaces it
 *   4. windows are partial until a baseline is 80% of the window old
 *   5. 7/14/30-day windows pick the snapshot nearest to now - N days
 *   6. account views for the same complete days come from the daily series
 *   7. a failing or hanging blob store leaves a warning and a normal refresh
 *   8. /api/snapshots returns one post's points across both month blobs, its
 *      gains per local (UTC+4) day, and the pre-tracking estimate (or none,
 *      when the post was published after tracking began)
 *   9. /api/snapshots?day= gives that local day's gains by platform, partial on
 *      the first tracked day, "not tracked" before it
 */

import { registerHooks } from "node:module";
import assert from "node:assert/strict";

// ------------------------------------------------------------- fake blobs
const stores = new Map();
// fail: { op: "get" | "set", match: RegExp, hang?: true } makes matching calls throw (or never return).
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

// Both platforms configured with fake credentials; every request is answered
// by the fake world below. META_APP_ID is left unset, so the token expiry check
// is skipped.
for (const k of ["META_APP_ID", "META_APP_SECRET", "IG_USER_ID", "META_AUTH"]) delete process.env[k];
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: "fake-client",
  GOOGLE_CLIENT_SECRET: "fake-secret",
  GOOGLE_REFRESH_TOKEN: "fake-refresh",
  META_ACCESS_TOKEN: "fake-meta-token",
  DASH_KEY: "test-key",
  // UTC+4, no daylight saving. IANA's Etc/GMT zones invert the sign.
  DASH_TZ: "Etc/GMT-4",
});

// ------------------------------------------------------------- fake clock
const RealDate = Date;
let nowMs = RealDate.parse("2026-10-31T00:00:00Z");
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(nowMs);
    else super(...args);
  }
  static now() {
    return nowMs;
  }
}
globalThis.Date = FakeDate;

// ------------------------------------------------------------- fake world
const H = 3600000;
const START = RealDate.parse("2026-10-31T00:00:00Z");
const hours = (ms) => (ms - START) / H;
const at = (h) => Math.round(START + h * H);

// Lifetime views as a function of hours since START.
const IG = {
  A: { id: "17900000000000001", ts: "2026-09-01T10:00:00+0000", views: (h) => 50000 + Math.round(1000 * h) },
  // No timestamp: tests the "publish time unknown" path.
  B: { id: "17900000000000002", ts: null, date: "2026-09-20", views: (h) => 8000 + Math.round(200 * h) },
  // Published 5 h before the final refresh.
  C: { id: "17900000000000003", ts: new RealDate(at(31 + 25 / 60)).toISOString().replace(".000Z", "+0000"), views: (h) => (h < 31 + 25 / 60 ? null : Math.round(300 * (h - (31 + 25 / 60)))) },
  // Its insights call fails at h=12, so it is missing from that snapshot.
  D: { id: "17900000000000004", ts: "2026-06-01T09:00:00+0000", views: (h) => 3000 + Math.round(10 * h), failAt: [12] },
  // Revised down by Instagram after h=12.
  E: { id: "17900000000000005", ts: "2026-08-01T09:00:00+0000", views: (h) => (h <= 12 ? 5000 : 4990) },
};
const YT = {
  V1: { id: "aaaaaaaaaa1", ts: "2026-09-10T12:00:00Z", views: (h) => 2000 + Math.round(50 * h) },
  V2: { id: "bbbbbbbbbb2", ts: "2026-10-25T12:00:00Z", views: (h) => 400 + Math.round(5 * h) },
};

function worldAt(ms) {
  const h = hours(ms);
  const ig_media = [];
  for (const m of Object.values(IG)) {
    if (m.ts && RealDate.parse(m.ts) > ms) continue; // not posted yet
    const views = m.failAt && m.failAt.some((x) => Math.abs(x - h) < 0.01) ? null : m.views(h);
    ig_media.push({
      media_id: m.id,
      media_shortcode: "sc" + m.id.slice(-4),
      timestamp: m.ts,
      date: m.ts ? m.ts.slice(0, 10) : m.date,
      media_product_type: "REELS",
      media_caption: "Reel " + m.id.slice(-1),
      media_views: views,
      media_reach: views === null ? null : Math.round(views * 0.8),
      media_like_count: 10,
      media_comments_count: 2,
      media_saved: 3,
      media_shares: 1,
    });
  }
  const yt_videos = Object.values(YT).map((v) => ({
    video: v.id,
    video_title: "Video " + v.id,
    published_at: v.ts,
    privacy_status: "public",
    views: v.views(h),
    video_view_count: v.views(h),
    likes: 5,
    comments: 1,
  }));
  // Account-level daily views for the 10 days before today (UTC), d days ago
  // carrying 100*d. Instagram reports through yesterday, YouTube lags 3 days.
  const ig_daily = [];
  const yt_daily = [];
  for (let d = 10; d >= 1; d--) {
    const date = new RealDate(ms - d * 24 * H).toISOString().slice(0, 10);
    ig_daily.push({ date, views: 100 * d, reach_1d: 50 });
    if (d >= 3) yt_daily.push({ date, views: 10 * d });
  }
  return {
    yt_channel: [{ channel_title: "Test", subscriber_count: 50, video_count: 2, view_count: 3000 }],
    yt_videos,
    yt_daily,
    ig_profile: [{ username: "test", followers_count: 1000, media_count: 5 }],
    ig_media,
    ig_daily,
  };
}

// The world above, served the way the Instagram Graph API (Facebook Login) and
// the YouTube Data and Analytics APIs answer meta.mjs and google.mjs.
let world = worldAt(START);
const IG_ID = "17841400000000002";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (status, code, message) => json({ error: { message, code } }, status);
const columns = (names, rows) => json({ columnHeaders: names.map((name) => ({ name })), rows });

function graph(url) {
  const p = url.searchParams;
  // The Instagram Login probe fails, so the token resolves through Facebook Login.
  if (url.host === "graph.instagram.com") return graphError(400, 190, "Invalid OAuth access token");
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
  if (path === "me/accounts") {
    return json({ data: [{ id: "page1", name: "Page", instagram_business_account: { id: IG_ID, username: "test" } }] });
  }
  if (path === IG_ID) return json(world.ig_profile[0]);
  if (path === IG_ID + "/media") {
    return json({
      data: world.ig_media.map((m) => ({
        id: m.media_id, shortcode: m.media_shortcode, caption: m.media_caption, media_type: "VIDEO",
        media_product_type: m.media_product_type, permalink: "https://example.com/instagram/" + m.media_shortcode,
        timestamp: m.timestamp || undefined, like_count: m.media_like_count, comments_count: m.media_comments_count,
      })),
      paging: {},
    });
  }
  if (path === IG_ID + "/insights") {
    if (p.get("metric") === "views") {
      const row = world.ig_daily.find((r) => r.date === p.get("since"));
      return json({ data: row ? [{ name: "views", period: "day", total_value: { value: row.views } }] : [] });
    }
    return json({ data: [] }); // reach, follower_count, demographics: nothing reported in this world
  }
  const m = world.ig_media.find((x) => path === x.media_id + "/insights");
  if (m) {
    // A post whose views are unknown at this moment: its insights call fails.
    if (m.media_views === null) return graphError(500, 2, "An unexpected error has occurred.");
    const values = { views: m.media_views, reach: m.media_reach, saved: m.media_saved, shares: m.media_shares, total_interactions: 16 };
    return json({ data: p.get("metric").split(",").map((name) => ({ name, period: "lifetime", values: [{ value: values[name] ?? 0 }] })) });
  }
  return graphError(400, 100, "unexpected request " + path);
}

function google(url) {
  const p = url.searchParams;
  if (url.host === "oauth2.googleapis.com") return json({ access_token: "fake-google-access", expires_in: 3600 });
  if (url.host === "www.googleapis.com") {
    const what = url.pathname.split("/").pop();
    const ch = world.yt_channel[0];
    if (what === "channels") {
      return json({ items: [{ id: "UC1", snippet: { title: ch.channel_title, thumbnails: {} },
        statistics: { subscriberCount: String(ch.subscriber_count), videoCount: String(ch.video_count), viewCount: String(ch.view_count) },
        contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
    }
    if (what === "playlistItems") return json({ items: world.yt_videos.map((v) => ({ contentDetails: { videoId: v.video } })) });
    if (what === "videos") {
      const ids = p.get("id").split(",");
      return json({ items: world.yt_videos.filter((v) => ids.includes(v.video)).map((v) => ({
        id: v.video, snippet: { title: v.video_title, publishedAt: v.published_at, thumbnails: {} }, contentDetails: { duration: "PT45S" },
        statistics: { viewCount: String(v.video_view_count), likeCount: String(v.likes), commentCount: String(v.comments) },
        status: { privacyStatus: v.privacy_status },
      })) });
    }
  }
  if (url.host === "youtubeanalytics.googleapis.com") {
    const dims = p.get("dimensions");
    if (dims === "video") return columns(["video", "views", "likes", "comments"], world.yt_videos.map((v) => [v.video, v.views, v.likes, v.comments]));
    if (dims === "day" && p.get("metrics").startsWith("views")) return columns(["day", "views"], world.yt_daily.map((r) => [r.date, r.views]));
    return columns([dims], []); // every other report: no rows in this world
  }
  return json({ error: "unexpected" }, 404);
}

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host.startsWith("graph.")) return graph(url);
  if (url.host.endsWith("googleapis.com")) return google(url);
  throw new Error("unexpected network call to " + url.host);
};

const { doRefresh, STORE_NAME, LATEST_KEY } = await import("../netlify/lib/refresh.mjs");
const { SNAP_INDEX_KEY } = await import("../netlify/lib/snapshots.mjs");
const { default: snapshotsHandler } = await import("../netlify/functions/snapshots.mts");

const blobs = () => stores.get(STORE_NAME);
async function refreshAt(ms) {
  nowMs = ms;
  world = worldAt(ms);
  globalThis.__testBlobs.ops = [];
  const dataset = await doRefresh();
  return { dataset, ops: globalThis.__testBlobs.ops.filter((o) => o.includes("snaps/")) };
}
const api = async (query, key = "test-key") => {
  const res = await snapshotsHandler(
    new Request("https://dash.test/api/snapshots" + query, { headers: key ? { "x-dash-key": key } : {} }),
    {}
  );
  return { status: res.status, body: await res.json() };
};
const passed = [];
const ok = (msg) => {
  passed.push(msg);
  console.log("  ok  " + msg);
};

// ================================================================ 1-4: 36 hours
console.log("\n12 refreshes over 36 h, 31 Oct 00:00Z to 1 Nov 12:00Z, then a manual one");
const schedule = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 36]; // 33h was a missed run
const runs = {};
for (const h of schedule) runs[h] = await refreshAt(at(h));

{
  const w = runs[9].dataset.snapshots.windows["1"];
  assert.equal(w.partial, true);
  assert.equal(w.from, new RealDate(at(0)).toISOString());
  assert.equal(runs[0].dataset.snapshots.windows["1"], null, "a single snapshot has nothing to compare with");
  ok("first refresh: no comparison yet; at 9 h the 24 h window is partial, from the oldest snapshot");
  const w21 = runs[21].dataset.snapshots.windows["1"];
  assert.equal(w21.partial, false, "21 h old is past 80% of a day");
  assert.equal(w21.from, new RealDate(at(0)).toISOString());
  ok("at 21 h the 24 h window is complete (oldest snapshot is >= 19.2 h old)");
}
{
  const { ops } = runs[3];
  const reads = ops.filter((o) => o.startsWith("get"));
  const writes = ops.filter((o) => o.startsWith("set"));
  assert.deepEqual(writes, ["set snaps/2026-10"], "steady state writes only the month blob");
  assert.ok(reads.length <= 3, "index + at most two month blobs");
  ok(`steady-state refresh does ${reads.length} parallel reads (${reads.join(", ")}) and 1 write`);
  const nov = runs[24].ops.filter((o) => o.startsWith("set"));
  assert.deepEqual(nov.sort(), ["set snaps/2026-11", "set snaps/index"], "a new month also updates the index");
  ok("first refresh of November writes the new month blob and the index");
}

const manual = at(36 + 25 / 60);
const final = await refreshAt(manual);
{
  const oct = blobs().get("snaps/2026-10");
  const nov = blobs().get("snaps/2026-11");
  assert.equal(oct.length, 8);
  assert.equal(nov.length, 4, "the manual refresh replaced the 12:00 entry");
  assert.equal(nov[3].t, new RealDate(manual).toISOString());
  const index = blobs().get(SNAP_INDEX_KEY);
  assert.deepEqual(index.months, ["snaps/2026-10", "snaps/2026-11"]);
  assert.equal(index.since, new RealDate(START).toISOString());
  ok("manual refresh 25 min later replaced the last entry (Oct 8 + Nov 4 entries, index lists both months)");
}

const snaps = final.dataset.snapshots;
const w1 = snaps.windows["1"];
{
  const hEnd = hours(manual);
  const hBase = 12; // nearest to now - 24h among snapshots >= 19.2h old
  assert.equal(w1.from, new RealDate(at(hBase)).toISOString());
  assert.equal(w1.partial, false);
  const g = (m) => m.views(hEnd) - m.views(hBase);
  const expected = [
    ["instagram", IG.A.id, g(IG.A)],
    ["instagram", IG.B.id, g(IG.B)],
    ["instagram", IG.C.id, IG.C.views(hEnd)],
    ["youtube", YT.V1.id, g(YT.V1)],
    ["youtube", YT.V2.id, g(YT.V2)],
    ["instagram", IG.E.id, 0],
    ["instagram", IG.D.id, null],
  ];
  assert.deepEqual(
    w1.rows.map((r) => [r.platform, r.id, r.gained]),
    expected,
    "rows sorted by gained, unknown last"
  );
  ok(`24 h baseline is the 31 Oct 12:00Z snapshot (in the October blob); order ${expected.map((e) => String(e[2])).join(" > ")}`);
  assert.equal(IG.C.views(hEnd), 1500);
  assert.equal(w1.rows.find((r) => r.id === IG.C.id).total, 1500);
  ok("reel published 5 h ago counts its full total (1,500)");
  assert.equal(w1.rows.find((r) => r.id === IG.D.id).gained, null);
  ok("old post missing from the baseline snapshot is null, not its whole total");
  assert.equal(w1.byPlatform.instagram.revised, 1);
  assert.equal(w1.revised, 1);
  ok("count revised down 5,000 -> 4,990 shows as 0 gained and revised: 1");
  const total = expected.reduce((a, e) => a + (e[2] || 0), 0);
  assert.equal(w1.totalGained, total);
  assert.equal(w1.byPlatform.instagram.totalGained, g(IG.A) + g(IG.B) + 1500);
  assert.equal(w1.byPlatform.youtube.totalGained, g(YT.V1) + g(YT.V2));
  assert.equal(w1.unknown, 1);
  ok(`totals: ${total} gained (Instagram ${w1.byPlatform.instagram.totalGained}, YouTube ${w1.byPlatform.youtube.totalGained}), 1 unknown`);
  assert.deepEqual(w1.accountViews.instagram, { from: "2026-10-31", to: "2026-10-31", days: 1, views: 100 });
  assert.equal(w1.accountViews.youtube, null, "YouTube has not reported 31 Oct yet");
  assert.deepEqual(snaps.windows["7"].accountViews, w1.accountViews, "a partial window covers only the tracked days");
  ok("account views: last complete day for 24 h; a partial 7d window only counts the days it covers"); 
  for (const d of ["7", "14", "30"]) {
    assert.equal(snaps.windows[d].partial, true);
    assert.equal(snaps.windows[d].from, new RealDate(START).toISOString());
  }
  assert.equal(snaps.windows["7"].rows.find((r) => r.id === IG.D.id).gained, IG.D.views(hEnd) - IG.D.views(0));
  ok("7/14/30-day windows are partial with 36 h of history, measured from the first snapshot");
  assert.equal(snaps.since, new RealDate(START).toISOString());
  assert.equal(snaps.latestAt, new RealDate(manual).toISOString());
  const latest = blobs().get(LATEST_KEY);
  assert.equal(latest.snapshots.windows["1"].totalGained, total);
  ok("summary is on the dataset written to `latest`, so /api/data stays one request");
}

// ================================================================ 8: series
console.log("\n/api/snapshots?platform=&id=");
{
  assert.equal((await api(`?platform=instagram&id=${IG.A.id}`, null)).status, 401);
  ok("gated like /api/data (401 without the key)");
  const { status, body } = await api(`?platform=instagram&id=${IG.A.id}`);
  assert.equal(status, 200);
  assert.equal(body.points.length, 12);
  assert.equal(body.points[0].t, "2026-10-31T00:00:00.000Z");
  assert.equal(body.points[7].t, "2026-10-31T21:00:00.000Z");
  assert.equal(body.points[8].t, "2026-11-01T00:00:00.000Z");
  assert.equal(body.points[11].views, IG.A.views(hours(manual)));
  ok("points run across the October and November blobs in order (12 points)");
  // UTC+4: 31 Oct 00:00Z-18:00Z is the 31st there, 21:00Z onwards the 1st.
  assert.deepEqual(
    body.daily.map((d) => [d.date, d.gained, !!d.partial]),
    [
      ["2026-10-31", IG.A.views(18) - IG.A.views(0), true],
      ["2026-11-01", IG.A.views(hours(manual)) - IG.A.views(18), false],
    ]
  );
  ok(`UTC+4 days: 31 Oct +${body.daily[0].gained} (partial, first tracked day), 1 Nov +${body.daily[1].gained} (31 Oct 21:00Z counts as 1 Nov)`);
  assert.deepEqual(body.estimate, {
    from: { t: "2026-09-01T10:00:00.000Z", views: 0 },
    to: { t: "2026-10-31T00:00:00.000Z", views: 50000 },
  });
  assert.equal(body.trackedFromPosting, false);
  ok("published before tracking: estimate runs from 0 at posting (1 Sep 10:00Z) to 50,000 at the first snapshot");

  const c = (await api(`?platform=instagram&id=${IG.C.id}`)).body;
  assert.equal(c.estimate, null);
  assert.equal(c.trackedFromPosting, true);
  assert.equal(c.points.length, 1);
  assert.deepEqual(c.daily.map((d) => [d.date, d.gained, !!d.partial]), [["2026-11-01", 1500, false]]);
  ok("published after tracking began: no estimate, one real point, first day counted from 0 at posting");

  const b = (await api(`?platform=instagram&id=${IG.B.id}`)).body;
  assert.equal(b.publishedAt, null);
  assert.equal(b.estimate, null);
  assert.equal(b.trackedFromPosting, false);
  ok("no publish time on record: no estimate (the UI falls back to 'tracking began')");

  const d = (await api(`?platform=instagram&id=${IG.D.id}`)).body;
  assert.equal(d.points.length, 11, "the snapshot where its views were unknown is skipped");
  const yt = (await api(`?platform=youtube&id=${YT.V2.id}`)).body;
  assert.equal(yt.points.length, 12);
  assert.equal(yt.estimate.from.t, "2026-10-25T12:00:00.000Z");
  ok("unknown views are skipped rather than recorded as 0; YouTube series work the same way");

  const none = await api("?platform=instagram&id=99999");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.points, []);
  assert.deepEqual(none.body.daily, []);
  assert.equal((await api("?platform=tiktok&id=1")).status, 400);
  assert.equal((await api("?platform=instagram&id=../x")).status, 400);
  ok("unknown id: 200 with empty points; bad platform or id: 400");
}

// ================================================================ 9: day
console.log("\n/api/snapshots?day=");
{
  const nov1 = (await api("?day=2026-11-01")).body;
  assert.equal(nov1.tracked, true);
  assert.equal(nov1.partial, false);
  assert.equal(nov1.complete, false, "1 Nov is today at UTC+4");
  assert.equal(nov1.from, "2026-10-31T18:00:00.000Z", "last snapshot of 31 Oct, UTC+4");
  assert.equal(nov1.to, new RealDate(manual).toISOString());
  const h0 = 18;
  const h1 = hours(manual);
  const igGain = IG.A.views(h1) - IG.A.views(h0) + (IG.B.views(h1) - IG.B.views(h0)) + 1500 + (IG.D.views(h1) - IG.D.views(h0));
  const ytGain = YT.V1.views(h1) - YT.V1.views(h0) + (YT.V2.views(h1) - YT.V2.views(h0));
  assert.equal(nov1.byPlatform.instagram.totalGained, igGain);
  assert.equal(nov1.byPlatform.youtube.totalGained, ytGain);
  assert.equal(nov1.totalGained, igGain + ytGain);
  assert.equal(nov1.rows[0].id, IG.A.id);
  ok(`1 Nov (UTC+4): +${nov1.totalGained} = Instagram ${igGain} + YouTube ${ytGain}, top post first`);

  const oct31 = (await api("?day=2026-10-31")).body;
  assert.equal(oct31.partial, true);
  assert.equal(oct31.from, "2026-10-31T00:00:00.000Z");
  assert.equal(oct31.to, "2026-10-31T18:00:00.000Z");
  assert.equal(oct31.complete, true);
  ok("31 Oct: partial (tracking began that day), measured from the first snapshot");

  const oct30 = (await api("?day=2026-10-30")).body;
  assert.equal(oct30.tracked, false);
  assert.equal((await api("?day=31-10-2026")).status, 400);
  ok("30 Oct: not tracked yet; malformed day: 400");
}

// ================================================================ 5: long history
console.log("\nWindows with weeks of history");
async function withHistory(days) {
  const s = blobs();
  for (const k of [...s.keys()]) if (k.startsWith("snaps/")) s.delete(k);
  const now = RealDate.parse("2026-12-20T09:00:00Z");
  const months = new Map();
  for (let t = now - days * 24 * H; t < now - H; t += 6 * H) {
    const key = "snaps/" + new RealDate(t).toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push({ t: new RealDate(t).toISOString(), ig: { [IG.A.id]: [Math.round((t - START) / 1000), 1, 1, 1, 1] }, yt: {} });
  }
  for (const [k, v] of months) s.set(k, v);
  s.set(SNAP_INDEX_KEY, { months: [...months.keys()].sort(), since: [...months.values()][0][0].t, published: { ig: {}, yt: {} } });
  return (await refreshAt(now)).dataset.snapshots.windows;
}
{
  const w = await withHistory(35);
  const iso = (dDays) => new RealDate(RealDate.parse("2026-12-20T09:00:00Z") - dDays * 24 * H).toISOString();
  assert.equal(w["1"].from, iso(1));
  assert.equal(w["7"].from, iso(7));
  assert.equal(w["14"].from, iso(14));
  assert.equal(w["30"].from, iso(30));
  assert.ok(["1", "7", "14", "30"].every((k) => w[k].partial === false));
  ok("35 days of history: every window starts at exactly now - N days, none partial (30d reads the November blob)");
  assert.deepEqual(w["7"].accountViews.instagram, { from: "2026-12-13", to: "2026-12-19", days: 7, views: 100 * (1 + 2 + 3 + 4 + 5 + 6 + 7) });
  assert.deepEqual(w["7"].accountViews.youtube, { from: "2026-12-13", to: "2026-12-17", days: 5, views: 10 * (3 + 4 + 5 + 6 + 7) });
  ok("account views over the 7 complete days: Instagram 13-19 Dec, YouTube through 17 Dec (its lag shown by `to`)");

  const w25 = await withHistory(25);
  assert.equal(w25["30"].partial, false, "25 days is past 80% of 30");
  assert.equal(w25["30"].from, iso(25));
  const w23 = await withHistory(23);
  assert.equal(w23["30"].partial, true, "23 days is short of 80% of 30");
  assert.equal(w23["30"].from, iso(23));
  assert.equal(w23["14"].partial, false);
  ok("80% rule: 25 days of history is a full 30-day window (from the oldest), 23 days is partial");
}

// ================================================================ 7: failures
console.log("\nRecording failures never fail the refresh");
{
  globalThis.__testBlobs.fail = { op: "get", match: /^snaps\// };
  const r1 = await refreshAt(RealDate.parse("2026-12-20T12:00:00Z"));
  assert.equal(r1.dataset.snapshots, null);
  assert.ok(r1.dataset.warnings.some((w) => w.startsWith("view snapshots: blob store get snaps/")));
  assert.equal(blobs().get(LATEST_KEY).generatedAt, r1.dataset.generatedAt, "latest still written");
  ok("read failure: warning '" + r1.dataset.warnings.find((w) => w.startsWith("view snapshots")) + "', latest still written");

  globalThis.__testBlobs.fail = { op: "set", match: /^snaps\// };
  const r2 = await refreshAt(RealDate.parse("2026-12-20T15:00:00Z"));
  assert.ok(r2.dataset.warnings.some((w) => w.startsWith("view snapshots: blob store set snaps/")));
  assert.equal(blobs().get(LATEST_KEY).generatedAt, r2.dataset.generatedAt);
  ok("write failure: warning, refresh result returned and stored");

  globalThis.__testBlobs.fail = { op: "get", match: /^snaps\/index$/, hang: true };
  const t0 = RealDate.now();
  const r3 = await refreshAt(RealDate.parse("2026-12-20T18:00:00Z"));
  const took = RealDate.now() - t0;
  assert.ok(r3.dataset.warnings.includes("view snapshots: timed out after 6000ms"));
  assert.ok(took < 8000);
  ok(`hung blob store: gave up after ${(took / 1000).toFixed(1)} s with a warning, refresh completed`);
  globalThis.__testBlobs.fail = null;
}

console.log(`\nall ${passed.length} checks passed`);
