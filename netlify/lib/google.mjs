// YouTube access: Data API v3 for metadata, Analytics API v2 for metrics.
// Emits the raw keys shape.mjs consumes (yt_channel, yt_videos, yt_daily, ...).

import { env } from "./env.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export function googleConfigured() {
  return Boolean(
    env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && env("GOOGLE_REFRESH_TOKEN")
  );
}

/**
 * Google refresh tokens do not expire unless revoked or unused for six months,
 * so there is no refresh-the-refresh-token dance here (unlike Meta).
 */
export async function getAccessToken(creds) {
  const clientId = creds?.clientId || env("GOOGLE_CLIENT_ID");
  const clientSecret = creds?.clientSecret || env("GOOGLE_CLIENT_SECRET");
  const refreshToken = creds?.refreshToken || env("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google credentials missing (need CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never echo the body wholesale: it can carry token material.
    throw new Error(`Google token refresh failed: ${res.status} ${body.error || ""} ${body.error_description || ""}`.trim());
  }
  return body.access_token;
}

async function apiGet(url, token, label) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    // The status rides on the error so a rejected metric (400) can be told
    // apart from an outage.
    const err = new Error(`${label}: HTTP ${res.status} ${text.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: response was not JSON`);
  }
}

/** Analytics returns columnHeaders + positional rows. Turn that into objects. */
function rowsToObjects(payload) {
  const cols = (payload.columnHeaders || []).map((c) => c.name);
  return (payload.rows || []).map((row) => {
    const obj = {};
    cols.forEach((name, i) => {
      obj[name] = row[i];
    });
    return obj;
  });
}

async function analytics(token, params, label) {
  const url = new URL(ANALYTICS_API);
  url.searchParams.set("ids", "channel==MINE");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return rowsToObjects(await apiGet(url, token, label));
}

const iso = (d) => d.toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

let regionNames = null;
function countryName(code) {
  if (!code) return code;
  try {
    if (!regionNames) regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

/** ISO 8601 duration (PT1M30S) to a readable length. */
function readableDuration(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
  const total = h * 3600 + min * 60 + s;
  if (!total) return null;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

async function listAllUploads(token, uploadsPlaylistId) {
  const ids = [];
  let pageToken = "";
  do {
    const url = new URL(`${DATA_API}/playlistItems`);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await apiGet(url, token, "playlistItems.list");
    for (const item of page.items || []) {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken && ids.length < 500);
  return ids;
}

async function videoDetails(token, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL(`${DATA_API}/videos`);
    url.searchParams.set("part", "snippet,contentDetails,statistics,status");
    url.searchParams.set("id", ids.slice(i, i + 50).join(","));
    url.searchParams.set("maxResults", "50");
    const page = await apiGet(url, token, "videos.list");
    out.push(...(page.items || []));
  }
  return out;
}

/**
 * Fetches everything the dashboard needs from YouTube, as raw rows for shape.mjs.
 */
export async function fetchYouTube(creds) {
  const token = await getAccessToken(creds);
  const warnings = [];

  // Optional reports degrade to [] rather than failing the whole pull.
  const soft = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err.message}`);
      return [];
    }
  };

  const channelUrl = new URL(`${DATA_API}/channels`);
  channelUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  channelUrl.searchParams.set("mine", "true");
  const channelPayload = await apiGet(channelUrl, token, "channels.list");
  const channel = (channelPayload.items || [])[0];
  if (!channel) throw new Error("No YouTube channel found for these credentials");

  const yt_channel = [
    {
      channel_title: channel.snippet?.title || null,
      channel_id: channel.id,
      channel_image: channel.snippet?.thumbnails?.default?.url || null,
      subscriber_count: Number(channel.statistics?.subscriberCount || 0),
      video_count: Number(channel.statistics?.videoCount || 0),
      view_count: Number(channel.statistics?.viewCount || 0),
    },
  ];

  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  const videoIds = uploads ? await listAllUploads(token, uploads) : [];
  const details = videoIds.length ? await videoDetails(token, videoIds) : [];

  // Per-video analytics, keyed by video id so metadata and metrics can be joined.
  const videoRows = await soft("yt video analytics", () =>
    analytics(token, {
      startDate: daysAgo(730),
      endDate: iso(new Date()),
      metrics:
        "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained",
      dimensions: "video",
      maxResults: "200",
      sort: "-views",
    }, "analytics video")
  );
  const byVideo = new Map(videoRows.map((r) => [r.video, r]));

  // video + creatorContentType is not a supported dimension pairing, but
  // creatorContentType filtered to a single video is. One call per public video
  // is cheap (Analytics queries do not draw on the Data API quota) and keeps the
  // Format column populated.
  const typeByVideo = new Map();
  const publicIds = details
    .filter((v) => v.status?.privacyStatus === "public")
    .map((v) => v.id);
  const typeResults = await Promise.all(
    publicIds.map(async (id) => {
      const rows = await soft(`yt content type ${id}`, () =>
        analytics(token, {
          startDate: daysAgo(730),
          endDate: iso(new Date()),
          metrics: "views",
          dimensions: "creatorContentType",
          filters: `video==${id}`,
          sort: "-views",
        }, "analytics contentType")
      );
      return [id, rows[0]?.creatorContentType || null];
    })
  );
  for (const [id, type] of typeResults) if (type) typeByVideo.set(id, type);

  const yt_videos = details.map((v) => {
    const a = byVideo.get(v.id) || {};
    return {
      video: v.id,
      video_title: v.snippet?.title || null,
      videourl: `https://www.youtube.com/watch?v=${v.id}`,
      videoimage: v.snippet?.thumbnails?.medium?.url || null,
      published_at: v.snippet?.publishedAt || null,
      video_length: readableDuration(v.contentDetails?.duration),
      creator_content_type: typeByVideo.get(v.id) || null,
      privacy_status: v.status?.privacyStatus || null,
      views: a.views ?? 0,
      engaged_views: a.views ?? null,
      estimated_minutes_watched: a.estimatedMinutesWatched ?? null,
      average_view_duration: a.averageViewDuration ?? null,
      average_view_percentage: a.averageViewPercentage ?? null,
      likes: a.likes ?? null,
      comments: a.comments ?? null,
      shares: a.shares ?? null,
      subscribers_gained: a.subscribersGained ?? null,
      video_view_count: Number(v.statistics?.viewCount || 0),
      video_like_count: v.statistics?.likeCount === undefined ? null : Number(v.statistics.likeCount),
      video_comment_count:
        v.statistics?.commentCount === undefined ? null : Number(v.statistics.commentCount),
    };
  });

  // Views by subscribed status rides alongside the daily query, in parallel, so
  // it adds a request but no time. Its own call: an unsupported pairing costs
  // only the split, never the daily series.
  const [dayRows, subscribedRows] = await Promise.all([
    soft("yt daily", () =>
      analytics(token, {
        startDate: daysAgo(90),
        endDate: iso(new Date()),
        metrics: "views,estimatedMinutesWatched,likes,comments,shares",
        dimensions: "day",
      }, "analytics day")
    ),
    soft("yt subscribed status", () =>
      analytics(token, {
        startDate: daysAgo(90),
        endDate: iso(new Date()),
        metrics: "views",
        dimensions: "day,subscribedStatus",
      }, "analytics subscribedStatus")
    ),
  ]);
  // The Analytics API omits days with no activity entirely. Left sparse, the
  // dashboard's line chart would break into disconnected segments on every quiet
  // day. A missing day here genuinely means zero views, so fill the range.
  //
  // Critically, the fill stops at the last day the API actually reported.
  // YouTube settles two to three days behind, and padding those trailing days
  // with zeros would draw a cliff to zero that never happened.
  const dayMap = new Map(dayRows.map((r) => [r.day, r]));
  const lastReported = dayRows.length
    ? dayRows.map((r) => r.day).sort().slice(-1)[0]
    : null;
  const yt_daily = [];
  for (let i = 90; i >= 0; i--) {
    const date = daysAgo(i);
    if (lastReported && date > lastReported) break;
    const r = dayMap.get(date);
    yt_daily.push({
      date,
      views: r?.views ?? 0,
      estimated_minutes_watched: r?.estimatedMinutesWatched ?? 0,
      likes: r?.likes ?? 0,
      comments: r?.comments ?? 0,
      shares: r?.shares ?? 0,
    });
  }

  // Same fill rule as the daily series: zeros for quiet days, but only up to
  // the last day this report reached, never into the lag.
  const subscribedByDay = new Map();
  for (const r of subscribedRows) {
    if (!r.day) continue;
    const e = subscribedByDay.get(r.day) || { subscribed: 0, unsubscribed: 0 };
    if (r.subscribedStatus === "SUBSCRIBED") e.subscribed += Number(r.views) || 0;
    else if (r.subscribedStatus === "UNSUBSCRIBED") e.unsubscribed += Number(r.views) || 0;
    subscribedByDay.set(r.day, e);
  }
  const subscribedLast = subscribedByDay.size ? [...subscribedByDay.keys()].sort().slice(-1)[0] : null;
  const yt_subscribed_daily = [];
  for (let i = 90; i >= 0 && subscribedLast; i--) {
    const date = daysAgo(i);
    if (date > subscribedLast) break;
    const e = subscribedByDay.get(date);
    yt_subscribed_daily.push({
      date,
      subscribed_views: e ? e.subscribed : 0,
      unsubscribed_views: e ? e.unsubscribed : 0,
    });
  }

  const subsRows = await soft("yt subscribers", () =>
    analytics(token, {
      startDate: daysAgo(90),
      endDate: iso(new Date()),
      metrics: "subscribersGained,subscribersLost",
      dimensions: "day",
    }, "analytics subs")
  );
  const yt_subs_daily = subsRows.map((r) => ({
    date: r.day,
    subscribers_gained_channel: r.subscribersGained,
    subscribers_lost_channel: r.subscribersLost,
  }));

  const trafficRows = await soft("yt traffic", () =>
    analytics(token, {
      startDate: daysAgo(90),
      endDate: iso(new Date()),
      metrics: "views,estimatedMinutesWatched",
      dimensions: "day,insightTrafficSourceType",
    }, "analytics traffic")
  );
  const yt_traffic = trafficRows.map((r) => ({
    date: r.day,
    traffic_source: r.insightTrafficSourceType,
    views: r.views,
    estimated_minutes_watched: r.estimatedMinutesWatched,
  }));

  const geoFor = async (days) => {
    const rows = await soft(`yt geo ${days}d`, () =>
      analytics(token, {
        startDate: daysAgo(days),
        endDate: iso(new Date()),
        metrics: "views,estimatedMinutesWatched",
        dimensions: "country",
        sort: "-views",
      }, `analytics geo${days}`)
    );
    // The API returns ISO country codes. Map them to names so the chart reads
    // "United Kingdom" rather than "GB".
    return rows.map((r) => ({
      country: countryName(r.country),
      views: r.views,
      estimated_minutes_watched: r.estimatedMinutesWatched,
    }));
  };
  const [yt_geo_90, yt_geo_30, yt_geo_14] = await Promise.all([geoFor(90), geoFor(30), geoFor(14)]);

  const ageRows = await soft("yt age", () =>
    analytics(token, {
      startDate: daysAgo(90),
      endDate: iso(new Date()),
      metrics: "viewerPercentage",
      dimensions: "ageGroup",
    }, "analytics age")
  );
  const yt_age = ageRows.map((r) => ({
    viewer_age_group: r.ageGroup,
    viewer_percentage: r.viewerPercentage,
  }));

  const genderRows = await soft("yt gender", () =>
    analytics(token, {
      startDate: daysAgo(90),
      endDate: iso(new Date()),
      metrics: "viewerPercentage",
      dimensions: "gender",
    }, "analytics gender")
  );
  const yt_gender = genderRows.map((r) => ({
    viewer_gender: r.gender,
    viewer_percentage: r.viewerPercentage,
  }));

  // Audience retention: one curve per video, for the handful with enough views
  // to be worth plotting.
  const retentionTargets = yt_videos
    .filter((v) => v.privacy_status === "public" && (v.video_view_count || 0) >= 100)
    .sort((a, b) => (b.video_view_count || 0) - (a.video_view_count || 0))
    .slice(0, 12);

  // Fetched in parallel, not sequentially. One request per video adds up fast
  // against the 30 second scheduled-function budget, and this list grows with
  // every video that clears the view threshold.
  const retentionResults = await Promise.all(
    retentionTargets.map(async (v) => {
      const rows = await soft(`yt retention ${v.video}`, () =>
        analytics(token, {
          startDate: daysAgo(730),
          endDate: iso(new Date()),
          metrics: "audienceWatchRatio,relativeRetentionPerformance",
          dimensions: "elapsedVideoTimeRatio",
          filters: `video==${v.video}`,
        }, "analytics retention")
      );
      return rows.map((r) => ({
        video: v.video,
        elapsed_ratio: r.elapsedVideoTimeRatio,
        watch_ratio: r.audienceWatchRatio,
        relative_performance: r.relativeRetentionPerformance,
      }));
    })
  );
  const yt_retention = retentionResults.flat();

  return {
    raw: {
      yt_channel,
      yt_videos,
      yt_daily,
      yt_subscribed_daily,
      yt_subs_daily,
      yt_traffic,
      yt_geo_90,
      yt_geo_30,
      yt_geo_14,
      yt_age,
      yt_gender,
      yt_retention,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- background
//
// Per-video details for the row drop-down, run by the details background
// function every 6 hours, never by the scheduled refresh. Each is its own
// query, so a metric YouTube rejects can only cost itself.

/** One authenticated session for a background run, counting its requests. */
export async function youtubeDetailsSession(creds) {
  const token = await getAccessToken(creds);
  const session = {
    requests: 1, // the token exchange
    async query(params, label) {
      session.requests++;
      return analytics(token, params, label);
    },
    /**
     * engagedViews for every video in one query, with views from the same
     * query so the share compares like with like. Never part of the refresh's
     * video analytics query: an unsupported metric there would blank every
     * video's numbers.
     */
    async engagedViews() {
      const rows = await session.query({
        startDate: daysAgo(730),
        endDate: iso(new Date()),
        metrics: "views,engagedViews",
        dimensions: "video",
        maxResults: "200",
        sort: "-views",
      }, "analytics engagedViews");
      return new Map(rows.map((r) => [r.video, { views: r.views ?? null, engagedViews: r.engagedViews ?? null }]));
    },
    /** Lifetime views of one video split by whether the viewer was subscribed; null when none reported. */
    async subscribedSplit(id) {
      const rows = await session.query({
        startDate: daysAgo(730),
        endDate: iso(new Date()),
        metrics: "views",
        dimensions: "subscribedStatus",
        filters: `video==${id}`,
      }, "analytics video subscribedStatus");
      if (!rows.length) return null;
      const out = { subscribed: 0, unsubscribed: 0 };
      for (const r of rows) {
        if (r.subscribedStatus === "SUBSCRIBED") out.subscribed += Number(r.views) || 0;
        else if (r.subscribedStatus === "UNSUBSCRIBED") out.unsubscribed += Number(r.views) || 0;
      }
      return out;
    },
  };
  return session;
}
