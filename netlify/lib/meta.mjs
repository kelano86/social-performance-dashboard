// Direct Instagram access.
//
// Meta ships two incompatible configurations and which one you get depends on
// how the app was set up:
//
//   Instagram Login  -> graph.instagram.com, token belongs to the IG account,
//                       no Facebook Page involved.
//   Facebook Login   -> graph.facebook.com, token belongs to the FB user, and
//                       the IG account is reached by walking Pages.
//
// Rather than force one, the token is probed once and the right path is used.
// Emits the same raw keys shape.mjs already consumes.

import { env } from "./env.mjs";
import { RECENT_DAYS } from "./igdaily.mjs";

const FB_GRAPH = "https://graph.facebook.com";
const IG_GRAPH = "https://graph.instagram.com";
const VERSION = "v21.0";

// Accounts can go back many years. Media older than this window is dropped
// entirely: pre-business-account posts return no insights at all, and old
// personal history is noise in a performance dashboard. Everything inside the window
// gets insights fetched, so nothing shown is ever a silent zero.
export const MEDIA_WINDOW_DAYS = 730;
export const DAILY_WINDOW_DAYS = 90;

export const FACEBOOK_LOGIN_SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_read_engagement",
  "pages_show_list",
];
export const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
];

export function metaConfigured() {
  return Boolean(env("META_ACCESS_TOKEN"));
}

async function get(host, path, token, params = {}, label = "graph") {
  const base = host === IG_GRAPH ? `${host}/${path}` : `${host}/${VERSION}/${path}`;
  const url = new URL(base);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 240);
    let code = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error?.message) msg = parsed.error.message;
      code = parsed.error?.code ?? null;
    } catch {
      /* keep raw snippet */
    }
    // Status and Graph error code ride on the error so callers can tell a
    // rejected metric or breakdown (400) from a rate limit or an outage.
    const err = new Error(`${label}: HTTP ${res.status} ${msg}`);
    err.status = res.status;
    err.graphCode = code;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Works out which configuration this token belongs to, and the account id.
 * Explicit META_AUTH ("instagram" | "facebook") skips the probe.
 */
export async function detectAuth(token) {
  const forced = (env("META_AUTH") || "").toLowerCase();

  if (forced !== "facebook") {
    try {
      const me = await get(IG_GRAPH, "me", token, { fields: "id,username" }, "ig me");
      if (me?.id) return { mode: "instagram", host: IG_GRAPH, igId: me.id, username: me.username };
    } catch (err) {
      if (forced === "instagram") throw err;
    }
  }

  const explicit = env("IG_USER_ID");
  if (explicit) return { mode: "facebook", host: FB_GRAPH, igId: explicit };

  const pages = await get(FB_GRAPH, "me/accounts", token, {
    fields: "id,name,instagram_business_account{id,username}",
    limit: "50",
  }, "me/accounts");
  for (const page of pages.data || []) {
    if (page.instagram_business_account?.id) {
      return {
        mode: "facebook",
        host: FB_GRAPH,
        igId: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        pageId: page.id,
      };
    }
  }
  throw new Error(
    "Token did not resolve to an Instagram account on either configuration. " +
      "For Facebook Login the account must be Business or Creator and linked to a Page; " +
      "for Instagram Login the token must come from Instagram business login."
  );
}

/**
 * Long-lived tokens last 60 days and must be exchanged while still valid. Once
 * expired they cannot be refreshed and need a fresh authorisation, so this is
 * the one piece of ongoing maintenance the direct path introduces.
 */
export async function refreshMetaToken(token, mode) {
  if (mode === "instagram") {
    const url = new URL(`${IG_GRAPH}/refresh_access_token`);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", token);
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Instagram token refresh failed: ${body.error?.message || res.status}`);
    return { token: body.access_token, expiresIn: body.expires_in };
  }
  const url = new URL(`${FB_GRAPH}/${VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", env("META_APP_ID"));
  url.searchParams.set("client_secret", env("META_APP_SECRET"));
  url.searchParams.set("fb_exchange_token", token);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta token refresh failed: ${body.error?.message || res.status}`);
  return { token: body.access_token, expiresIn: body.expires_in };
}

/** Days remaining on the token, so a dying credential is visible before it dies. */
export async function inspectToken(token) {
  if (!env("META_APP_ID") || !env("META_APP_SECRET")) return null;
  try {
    const data = await get(FB_GRAPH, "debug_token", `${env("META_APP_ID")}|${env("META_APP_SECRET")}`, {
      input_token: token,
    }, "debug_token");
    const expiresAt = data.data?.expires_at;
    if (!expiresAt) return { expiresAt: null, daysLeft: null, neverExpires: true };
    return {
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      daysLeft: Math.round((expiresAt * 1000 - Date.now()) / 86400000),
      neverExpires: false,
    };
  } catch {
    return null;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}
function nextDay(date) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

/** The days the daily account series covers: DAILY_WINDOW_DAYS days, oldest first, ending yesterday (UTC). */
export function dailyWindow() {
  const days = [];
  for (let i = DAILY_WINDOW_DAYS; i >= 1; i--) days.push(daysAgo(i));
  return days;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Bounded-concurrency map. Meta rate-limits, and some of these fan out to ~90 calls. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function seriesByDate(insights, name) {
  const entry = (insights || []).find((i) => i.name === name);
  const out = new Map();
  for (const v of entry?.values || []) {
    if (!v.end_time) continue;
    out.set(String(v.end_time).slice(0, 10), v.value);
  }
  return out;
}

function breakdownRows(insights, name) {
  const entry = (insights || []).find((i) => i.name === name);
  const results = entry?.total_value?.breakdowns?.[0]?.results || [];
  return results.map((r) => ({ key: (r.dimension_values || [])[0], value: r.value }));
}

/**
 * The refresh's pull. `opts.igDaily` is the pending read of the daily cache
 * (igdaily.mjs): days it already holds are not requested again, and the
 * follower split and follows/unfollows come from it. Without it, every day is
 * requested, exactly as before the cache existed.
 */
export async function fetchInstagram(tokenOverride, opts = {}) {
  const token = tokenOverride || env("META_ACCESS_TOKEN");
  if (!token) throw new Error("META_ACCESS_TOKEN is not set");

  const warnings = [];
  const soft = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err.message}`);
      return fallback;
    }
  };

  const auth = await detectAuth(token);
  const { host, igId } = auth;
  // Instagram Login addresses the owner as "me"; Facebook Login needs the id.
  const self = auth.mode === "instagram" ? "me" : igId;

  const profile = await get(host, self, token, {
    fields: "username,name,followers_count,follows_count,media_count,biography,website",
  }, "ig profile");
  const ig_profile = [
    {
      username: profile.username,
      name: profile.name,
      followers_count: profile.followers_count,
      follows_count: profile.follows_count,
      media_count: profile.media_count,
      biography: profile.biography,
      website: profile.website,
    },
  ];

  // ---- media ----
  const media = [];
  let after = "";
  do {
    const page = await get(host, `${self}/media`, token, {
      fields:
        "id,shortcode,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count",
      limit: "50",
      after: after || undefined,
    }, "ig media");
    media.push(...(page.data || []));
    after = page.paging?.next ? page.paging?.cursors?.after : "";
  } while (after && media.length < 200);

  const mediaCutoff = daysAgo(MEDIA_WINDOW_DAYS);
  const inWindow = media.filter(
    (m) => !m.timestamp || String(m.timestamp).slice(0, 10) >= mediaCutoff
  );

  const ig_media = await mapLimit(inWindow, 8, async (m) => {
    const isReel = m.media_product_type === "REELS";

    // Metric availability differs by surface, and a single unsupported metric
    // fails the whole call, so the list is built per media type. Reel-only
    // metrics are requested separately from the core set: that way a reel whose
    // watch-time metrics are unavailable still returns views and reach instead
    // of losing everything.
    const CORE = "views,reach,saved,shares,total_interactions";
    const REEL_EXTRA = "ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate";

    let insights = await soft(
      `ig insights ${m.shortcode || m.id}`,
      async () => (await get(host, `${m.id}/insights`, token, { metric: CORE }, "ig media insights")).data,
      []
    );
    if (isReel) {
      const extra = await soft(
        `ig reel metrics ${m.shortcode || m.id}`,
        async () => (await get(host, `${m.id}/insights`, token, { metric: REEL_EXTRA }, "ig reel insights")).data,
        []
      );
      insights = insights.concat(extra);
    }
    const val = (name) => {
      const e = insights.find((i) => i.name === name);
      const v = e?.values?.[0]?.value;
      return v === undefined ? null : v;
    };
    const skip = val("reels_skip_rate");

    return {
      date: m.timestamp ? String(m.timestamp).slice(0, 10) : null,
      timestamp: m.timestamp,
      media_id: m.id,
      media_shortcode: m.shortcode,
      media_permalink: m.permalink,
      media_type: m.media_type,
      media_product_type: m.media_product_type,
      media_caption: m.caption,
      media_thumbnail_url: m.thumbnail_url || m.media_url,
      media_views: val("views"),
      media_reach: val("reach"),
      media_like_count: m.like_count,
      media_comments_count: m.comments_count,
      media_saved: val("saved"),
      media_shares: val("shares"),
      media_engagement: val("total_interactions"),
      media_reel_avg_watch_time: val("ig_reels_avg_watch_time"),
      media_reel_total_watch_time: val("ig_reels_video_view_total_time"),
      // Meta reports this as a percentage; shape.mjs expects a fraction.
      media_reel_skip_rate: skip === null ? null : skip / 100,
    };
  });

  // ---- daily account insights ----
  //
  // Only `reach` and `follower_count` support metric_type=time_series. Everything
  // else, `views` included, is total_value only, which returns one aggregate for
  // the whole window rather than a series. The way to get daily views is to ask
  // for a one-day window at a time.
  // reach rejects any span longer than 30 days, so the window is walked in
  // chunks rather than requested in one go.
  const reachChunks = [];
  for (let start = DAILY_WINDOW_DAYS; start > 0; start -= 29) {
    reachChunks.push({ since: daysAgo(start), until: daysAgo(Math.max(start - 29, 0)) });
  }
  const reachSeries = new Map();
  await mapLimit(reachChunks, 4, async (chunk) => {
    const data = await soft(
      `ig reach ${chunk.since}`,
      async () =>
        (await get(host, `${self}/insights`, token, {
          metric: "reach",
          period: "day",
          metric_type: "time_series",
          since: chunk.since,
          until: chunk.until,
        }, "ig reach")).data,
      []
    );
    for (const [date, value] of seriesByDate(data, "reach")) reachSeries.set(date, value);
  });

  const days = dailyWindow();

  // Days the details background function has already stored are read from the
  // cache. Only the last RECENT_DAYS (still being revised) and any day it does
  // not hold yet are requested, plain, as they always were: the refresh never
  // asks for the follower split or follows_and_unfollows itself, and never
  // writes the cache, so a cold cache costs exactly what the refresh cost before.
  const cache = opts.igDaily ? await opts.igDaily : null;
  if (cache?.error) warnings.push(`ig daily cache: ${cache.error}`);
  const cached = cache?.days || new Map();
  const recentFrom = daysAgo(RECENT_DAYS);
  const cachedViews = (date) => num(cached.get(date)?.views);
  const toFetch = days.filter((date) => date >= recentFrom || cachedViews(date) === null);

  const viewsByDate = new Map();
  await mapLimit(toFetch, 8, async (date) => {
    const data = await soft(
      `ig views ${date}`,
      async () =>
        (await get(host, `${self}/insights`, token, {
          metric: "views",
          period: "day",
          metric_type: "total_value",
          since: date,
          until: nextDay(date),
        }, "ig views")).data,
      null
    );
    const value = data?.[0]?.total_value?.value;
    if (value !== undefined && value !== null) viewsByDate.set(date, value);
  });
  // A recent day whose request failed still has the background's figure.
  for (const date of days) {
    if (!viewsByDate.has(date) && cachedViews(date) !== null) viewsByDate.set(date, cachedViews(date));
  }

  const dates = new Set([...reachSeries.keys(), ...viewsByDate.keys()]);
  const ig_daily = [...dates].sort().map((date) => {
    const split = cached.get(date)?.viewsSplit;
    return {
      date,
      views: viewsByDate.has(date) ? viewsByDate.get(date) : null,
      reach_1d: reachSeries.has(date) ? reachSeries.get(date) : null,
      views_follower: split ? num(split.follower) : null,
      views_non_follower: split ? num(split.nonFollower) : null,
      views_unknown: split ? num(split.unknown) : null,
    };
  });

  // Real follows and unfollows per day, as stored by the background function.
  const ig_follows_daily = days
    .filter((date) => num(cached.get(date)?.follows) !== null && num(cached.get(date)?.unfollows) !== null)
    .map((date) => ({ date, follows: num(cached.get(date).follows), unfollows: num(cached.get(date).unfollows) }));

  // follower_count is capped at 30 days excluding today, so it gets its own
  // request: mixed into a wider query it makes the whole call fail with a 400.
  const followerInsights = await soft(
    "ig followers daily",
    async () =>
      (await get(host, `${self}/insights`, token, {
        metric: "follower_count",
        period: "day",
        since: daysAgo(29),
        until: daysAgo(1),
      }, "ig follower_count")).data,
    []
  );
  const followerSeries = seriesByDate(followerInsights, "follower_count");
  const ig_followers_daily = [...followerSeries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, follower_count: value }));

  // ---- audience demographics ----
  const demo = (breakdown) =>
    soft(
      `ig demographics ${breakdown}`,
      async () =>
        (await get(host, `${self}/insights`, token, {
          metric: "follower_demographics",
          period: "lifetime",
          metric_type: "total_value",
          breakdown,
        }, "ig demographics")).data,
      []
    );

  const [countryData, ageData, genderData] = await Promise.all([
    demo("country"),
    demo("age"),
    demo("gender"),
  ]);

  return {
    raw: {
      ig_profile,
      ig_media,
      ig_daily,
      ig_followers_daily,
      ig_follows_daily,
      ig_geo: breakdownRows(countryData, "follower_demographics").map((r) => ({
        audience_country_name: r.key,
        audience_country_size: r.value,
      })),
      ig_age: breakdownRows(ageData, "follower_demographics").map((r) => ({
        audience_age_name: r.key,
        audience_age_size: r.value,
      })),
      ig_gender: breakdownRows(genderData, "follower_demographics").map((r) => ({
        audience_gender_name: r.key,
        audience_gender_size: r.value,
      })),
    },
    warnings,
    igId,
    authMode: auth.mode,
  };
}

// ---------------------------------------------------------------- background
//
// Everything below runs only in the details background function (15 minutes),
// never in the scheduled refresh (30 seconds). None of these metric names was
// verified against the live API when this was written, so every call is built
// to fail narrowly: a rejected metric or breakdown is dropped for the rest of
// the run with one warning, and a failure never costs data that already works.

// Rate limits and outages are worth retrying next run; anything else that comes
// back 400 is Instagram refusing the request as asked.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);
function isRejection(err) {
  if (err?.status !== 400) return false;
  const c = err.graphCode;
  return !(c === 190 || TRANSIENT_CODES.has(c) || (c >= 80000 && c < 81000));
}

async function attempt(fn) {
  try {
    return { ok: true, data: (await fn())?.data || [] };
  } catch (err) {
    return { ok: false, err, rejected: isRejection(err) };
  }
}

/**
 * One authenticated session for a background run, counting its requests (not
 * counting detectAuth's one or two).
 */
export async function instagramSession(tokenOverride) {
  const token = tokenOverride || env("META_ACCESS_TOKEN");
  if (!token) throw new Error("META_ACCESS_TOKEN is not set");
  const auth = await detectAuth(token);
  const session = {
    auth,
    self: auth.mode === "instagram" ? "me" : auth.igId,
    requests: 0,
    call(path, params, label) {
      session.requests++;
      return get(auth.host, path, token, params, label);
    },
  };
  return session;
}

// The spec asks for follow_type on views; Meta's docs list follower_type for
// views and follow_type for reach and follows_and_unfollows. Neither is
// verified for views, so follow_type is tried first and follower_type second.
export const SPLIT_BREAKDOWNS = ["follow_type", "follower_type"];

/** { follower, nonFollower, unknown } from a total_value breakdown, or null. */
function parseSplit(entry) {
  const tv = entry?.total_value;
  const results = tv?.breakdowns?.[0]?.results;
  if (!Array.isArray(results) || !results.length) {
    return num(tv?.value) === 0 ? { follower: 0, nonFollower: 0, unknown: 0 } : null;
  }
  const out = { follower: 0, nonFollower: 0, unknown: 0 };
  for (const r of results) {
    const key = String((r.dimension_values || [])[0] || "").toUpperCase();
    const v = num(r.value) || 0;
    if (key === "FOLLOWER") out.follower += v;
    else if (key === "NON_FOLLOWER") out.nonFollower += v;
    else out.unknown += v;
  }
  return out;
}

/** Total views from a total_value entry, falling back to the breakdown sum. */
function totalViews(entry, split) {
  const v = num(entry?.total_value?.value);
  if (v !== null) return v;
  return split ? split.follower + split.nonFollower + split.unknown : null;
}

/**
 * Account-level daily history for the cache: views with their follower split,
 * and follows_and_unfollows (FOLLOWER = follows, NON_FOLLOWER = unfollows).
 * Requests only the days `cached` lacks, plus the last RECENT_DAYS. Returns
 * the per-day updates for writeIgDaily, never throws for a single day.
 */
export async function fetchInstagramDaily(session, cached) {
  const days = dailyWindow();
  const recentFrom = daysAgo(RECENT_DAYS);
  const updates = new Map();
  const put = (date, fields) => updates.set(date, { ...(updates.get(date) || {}), ...fields, at: new Date().toISOString() });
  const warnings = [];
  const deadBreakdowns = new Map(); // name -> first error message
  const failed = { views: [], follows: [] };
  let followsRejected = null;
  let splitDays = 0;

  const needViews = days.filter((d) => d >= recentFrom || num(cached.get(d)?.views) === null);
  const needFollows = days.filter((d) => d >= recentFrom || cached.get(d)?.follows === undefined);

  const base = (metric, date) => ({ metric, period: "day", metric_type: "total_value", since: date, until: nextDay(date) });
  const insights = (params, label) => () => session.call(`${session.self}/insights`, params, label);

  async function viewsDay(date) {
    // Breakdowns that failed on this day. They count as rejected only once a
    // request without them succeeds, which shows the day itself was fine.
    const tried = [];
    for (const name of SPLIT_BREAKDOWNS) {
      if (deadBreakdowns.has(name)) continue;
      const r = await attempt(insights({ ...base("views", date), breakdown: name }, "ig views split"));
      if (r.ok) {
        for (const t of tried) if (!deadBreakdowns.has(t.name)) deadBreakdowns.set(t.name, t.message);
        const entry = r.data.find((e) => e.name === "views") || r.data[0];
        const split = parseSplit(entry);
        const views = totalViews(entry, split);
        if (views === null) break; // nothing usable: ask plainly below
        if (split) splitDays++;
        put(date, { views, viewsSplit: split });
        return;
      }
      if (!r.rejected) {
        // Rate limit or outage: store nothing, so the day (split included) is
        // retried next run. The refresh still requests its plain views meanwhile.
        failed.views.push(r.err.message);
        return;
      }
      tried.push({ name, message: r.err.message });
    }
    const r = await attempt(insights(base("views", date), "ig views"));
    const value = r.ok ? num(r.data[0]?.total_value?.value) : null;
    if (value === null) {
      failed.views.push(r.ok ? `${date}: no value` : r.err.message);
      return;
    }
    for (const t of tried) if (!deadBreakdowns.has(t.name)) deadBreakdowns.set(t.name, t.message);
    put(date, { views: value, viewsSplit: null });
  }

  async function followsDay(date) {
    if (followsRejected) return;
    const r = await attempt(
      insights({ ...base("follows_and_unfollows", date), breakdown: "follow_type" }, "ig follows_and_unfollows")
    );
    if (!r.ok) {
      if (r.rejected) followsRejected = followsRejected || r.err.message;
      else failed.follows.push(r.err.message);
      return;
    }
    const split = parseSplit(r.data.find((e) => e.name === "follows_and_unfollows") || r.data[0]);
    // FOLLOWER is accounts that followed, NON_FOLLOWER accounts that unfollowed
    // (or left Instagram). Anything else is not a follow event.
    put(date, split ? { follows: split.follower, unfollows: split.nonFollower } : { follows: null, unfollows: null });
  }

  const tasks = [
    ...needViews.map((d) => () => viewsDay(d)),
    ...needFollows.map((d) => () => followsDay(d)),
  ];
  await mapLimit(tasks, 8, (task) => task());

  const live = SPLIT_BREAKDOWNS.find((n) => !deadBreakdowns.has(n)) || null;
  if (deadBreakdowns.size) {
    const names = [...deadBreakdowns.keys()].map((n) => `breakdown=${n}`).join(" and ");
    const first = [...deadBreakdowns.values()][0];
    warnings.push(
      live && splitDays
        ? `ig views split: Instagram rejected ${names} (${first}); used breakdown=${live} instead`
        : `ig views split: Instagram rejected ${names} (${first}); daily views were fetched without the follower split for the rest of this run`
    );
  }
  if (followsRejected) {
    warnings.push(`ig follows: Instagram rejected follows_and_unfollows (${followsRejected}); not requested for the rest of this run`);
  }
  for (const [kind, list] of Object.entries(failed)) {
    if (list.length) warnings.push(`ig ${kind}: ${list.length} day(s) failed and will be retried next run (first: ${list[0]})`);
  }

  return {
    updates,
    warnings,
    requested: { views: needViews.length, follows: followsRejected ? null : needFollows.length },
    splitBreakdown: splitDays ? live : null,
    followsRejected: Boolean(followsRejected),
  };
}

// Per-media metrics for the row drop-down. Requested in their own call, never
// mixed into CORE / REEL_EXTRA, so a rejected name cannot cost the existing ones.
export const MEDIA_DETAIL_METRICS = ["follows", "profile_visits", "reposts"];
// Meta documents follows and profile_visits for feed posts and stories only, and
// no follow-type breakdown on media views at all (confirmed against the live
// API), so reels are only asked for reposts and the split is not tried.
const SURFACE_METRICS = { REELS: ["reposts"] };
const TRY_MEDIA_VIEWS_SPLIT = false;
const DETAIL_FIELD = { follows: "follows", profile_visits: "profileVisits", reposts: "reposts" };

// Which metric a "metric[i] must be one of ..." style message points at.
function culprit(err, wanted) {
  const msg = String(err?.message || "");
  const idx = msg.match(/metric\[(\d+)\]/);
  if (idx && wanted[Number(idx[1])]) return wanted[Number(idx[1])];
  // A message listing the valid values names healthy metrics too.
  if (/one of/i.test(msg)) return null;
  const named = wanted.filter((n) => new RegExp(`\\b${n}\\b`).test(msg));
  return named.length === 1 ? named[0] : null;
}

/**
 * Per-media details for a run. Metric support differs by surface (reels vs
 * feed posts), so a rejection is remembered per surface and that metric is not
 * asked of that surface again this run. A rejection only counts once the post
 * itself has answered some request; if nothing answers, the post failed and the
 * caller records that instead. `summary()` gives the one warning naming
 * everything that was rejected.
 */
export function mediaDetailsFetcher(session) {
  const dropped = new Map(); // surface -> Map(metric -> first message)
  const droppedFor = (surface) => {
    if (!dropped.has(surface)) dropped.set(surface, new Map());
    return dropped.get(surface);
  };
  const call = (id, params) => () => session.call(`${id}/insights`, params, "ig media details");

  async function fetchMedia(m) {
    const surface = String(m.format || "FEED").toUpperCase();
    const skip = droppedFor(surface);
    const skippedAtStart = [...skip.keys()];
    const rec = { follows: null, profileVisits: null, reposts: null, viewsSplit: null, missing: {} };
    const rejectedHere = []; // { name, message }
    let healthy = false;
    const assign = (data, names) => {
      for (const n of names) {
        const e = data.find((x) => x.name === n);
        const v = num(e?.values?.[0]?.value ?? e?.total_value?.value);
        rec[DETAIL_FIELD[n]] = v;
      }
    };

    // 1. follows, profile_visits, reposts in one call, peeling off a rejected name at a time
    let wanted = (SURFACE_METRICS[surface] || MEDIA_DETAIL_METRICS).filter((n) => !skip.has(n));
    while (wanted.length) {
      const r = await attempt(call(m.id, { metric: wanted.join(",") }));
      if (r.ok) {
        healthy = true;
        assign(r.data, wanted);
        break;
      }
      if (!r.rejected) throw r.err;
      const named = wanted.length === 1 ? wanted[0] : culprit(r.err, wanted);
      if (named) {
        rejectedHere.push({ name: named, message: r.err.message });
        wanted = wanted.filter((n) => n !== named);
        continue;
      }
      // The message does not say which: ask for each on its own.
      for (const n of wanted) {
        const one = await attempt(call(m.id, { metric: n }));
        if (one.ok) {
          healthy = true;
          assign(one.data, [n]);
        } else if (one.rejected) rejectedHere.push({ name: n, message: one.err.message });
        else throw one.err;
      }
      break;
    }

    // 2. views by follow type, in its own call
    for (const b of TRY_MEDIA_VIEWS_SPLIT ? SPLIT_BREAKDOWNS : []) {
      const key = `views:${b}`;
      if (skip.has(key)) continue;
      const r = await attempt(call(m.id, { metric: "views", breakdown: b }));
      if (r.ok) {
        healthy = true;
        rec.viewsSplit = parseSplit(r.data.find((e) => e.name === "views") || r.data[0]);
        break;
      }
      if (!r.rejected) throw r.err;
      rejectedHere.push({ name: key, message: r.err.message });
    }

    // 3. a rejection only counts against a metric if the post itself answers
    if (rejectedHere.length && !healthy) {
      const r = await attempt(call(m.id, { metric: "views" }));
      if (!r.ok) throw r.err;
    }
    for (const { name, message } of rejectedHere) if (!skip.has(name)) skip.set(name, message);

    for (const name of [...skippedAtStart, ...rejectedHere.map((x) => x.name)]) {
      if (DETAIL_FIELD[name]) rec.missing[DETAIL_FIELD[name]] = "unsupported";
    }
    for (const n of MEDIA_DETAIL_METRICS) {
      if (SURFACE_METRICS[surface] && !SURFACE_METRICS[surface].includes(n)) rec.missing[DETAIL_FIELD[n]] = "unsupported";
    }
    if (!rec.viewsSplit && (!TRY_MEDIA_VIEWS_SPLIT || SPLIT_BREAKDOWNS.every((b) => skip.has(`views:${b}`)))) rec.missing.viewsSplit = "unsupported";

    // Fresh posts report literal zeros until Instagram has computed them.
    if (m.insightsPending) {
      for (const f of Object.values(DETAIL_FIELD)) {
        if (!rec.missing[f] && !rec[f]) {
          rec[f] = null;
          rec.missing[f] = "pending";
        }
      }
      const s = rec.viewsSplit;
      if (!rec.missing.viewsSplit && (!s || s.follower + s.nonFollower + s.unknown === 0)) {
        rec.viewsSplit = null;
        rec.missing.viewsSplit = "pending";
      }
    }
    return rec;
  }

  function summary() {
    const parts = [];
    for (const [surface, map] of dropped) {
      if (!map.size) continue;
      const names = [...map.keys()].map((n) => n.replace("views:", "views breakdown="));
      parts.push(`${surface.toLowerCase()}: ${names.join(", ")} (${[...map.values()][0]})`);
    }
    return parts.length
      ? `ig post details: Instagram rejected ${parts.join("; ")}; dropped for the rest of this run`
      : null;
  }

  return { fetchMedia, summary, dropped };
}
