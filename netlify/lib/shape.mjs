// Turns the raw platform rows (google.mjs, meta.mjs) into the exact payload
// the dashboard renders.
// All cross-platform blending happens here so the frontend stays dumb.

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sum = (arr) => arr.reduce((a, b) => a + (num(b) || 0), 0);

/** Collapses repeated rows for the same key (or every row, with no key) into one. */
function dedupe(rows, keyField) {
  const map = new Map();
  for (const row of rows || []) {
    const k = keyField ? row[keyField] : "__single__";
    if (k === null || k === undefined) continue;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { ...row });
      continue;
    }
    // Identical repeats: keep the largest numeric seen, preserve first non-empty text.
    for (const [f, v] of Object.entries(row)) {
      const n = num(v);
      if (n !== null) {
        const pn = num(prev[f]);
        if (pn === null || n > pn) prev[f] = v;
      } else if (prev[f] === null || prev[f] === undefined || prev[f] === "") {
        prev[f] = v;
      }
    }
  }
  return [...map.values()];
}

function breakdown(rows, labelField, valueField, limit = 12) {
  const map = new Map();
  for (const r of rows || []) {
    const label = r[labelField];
    const v = num(r[valueField]);
    if (!label || v === null) continue;
    map.set(label, (map.get(label) || 0) + v);
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function firstRow(rows) {
  const d = dedupe(rows, null);
  return d[0] || {};
}

/** Exact publish time as ISO, or null. Instagram sends "+0000" offsets. */
function instant(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Caption/title down to something that fits a table cell. */
function trimTitle(text, fallback) {
  if (!text || typeof text !== "string") return fallback;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 90 ? clean.slice(0, 89) + "…" : clean;
}

export function shape(raw) {
  raw = raw || {};

  // ---------- YouTube ----------
  const ytChannel = firstRow(raw.yt_channel);
  const ytVideos = dedupe(raw.yt_videos, "video")
    // Only public uploads. The Analytics API also returns private and unlisted
    // videos (old clips, unlisted links) which are not published content and
    // badly inflate the counts.
    .filter((r) => String(r.privacy_status || "").toLowerCase() === "public")
    .map((r) => {
      // Two different view numbers come back and neither is reliably the larger:
      //   views            - Analytics, bounded by the query window, and 0 for
      //                      anything published inside YouTube's ~3 day
      //                      reporting lag.
      //   video_view_count - Data API lifetime total, live immediately.
      // A nullish fallback is wrong here because the analytics value is 0, not
      // null, for a fresh upload. Take the larger of the two.
      const analyticsViews = num(r.views) || 0;
      const lifetimeViews = num(r.video_view_count) || 0;
      const views = Math.max(analyticsViews, lifetimeViews);
      const likes = Math.max(num(r.likes) || 0, num(r.video_like_count) || 0);
      const comments = Math.max(num(r.comments) || 0, num(r.video_comment_count) || 0);
      const shares = num(r.shares) ?? 0;

      // A video published inside the reporting lag has a live lifetime view
      // count but no analytics yet. Every analytics-derived figure for it would
      // be a literal zero, and "0% average view" on a video with a thousand
      // views reads as catastrophic retention rather than as data that has not landed.
      // Blank those out instead.
      const analyticsPending = analyticsViews === 0 && lifetimeViews > 0;

      const minutes = analyticsPending ? null : num(r.estimated_minutes_watched);
      // average_view_duration can come back null, but the metric is just total
      // watch time over views, so derive it rather than showing an empty column.
      const avgWatch = analyticsPending
        ? null
        : num(r.average_view_duration) ??
          (minutes !== null && views > 0 ? (minutes * 60) / views : null);
      return {
        platform: "youtube",
        id: r.video,
        title: trimTitle(r.video_title, r.video),
        url: r.videourl || (r.video ? "https://www.youtube.com/watch?v=" + r.video : null),
        thumbnail: r.videoimage || null,
        date: r.published_at ? String(r.published_at).slice(0, 10) : null,
        publishedAt: instant(r.published_at),
        format: r.creator_content_type || null,
        privacy: r.privacy_status || null,
        length: r.video_length || null,
        views,
        engagedViews: num(r.engaged_views),
        reach: null, // YouTube exposes no reach metric
        likes,
        comments,
        shares,
        saves: null, // no equivalent on YouTube
        followsGained: analyticsPending ? null : num(r.subscribers_gained),
        minutesWatched: minutes,
        avgWatchSeconds: avgWatch,
        avgViewPercent: analyticsPending ? null : num(r.average_view_percentage),
        analyticsPending,
        skipRate: null, // Instagram-only
        engagement: likes + comments + shares,
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // ---------- Instagram ----------
  const igProfile = firstRow(raw.ig_profile);
  const igMedia = dedupe(raw.ig_media, "media_id")
    .map((r) => {
      const likes = num(r.media_like_count) ?? 0;
      const comments = num(r.media_comments_count) ?? 0;
      const shares = num(r.media_shares) ?? 0;
      const saves = num(r.media_saved) ?? 0;
      const views = num(r.media_views) ?? 0;
      const reach = num(r.media_reach);
      // Instagram returns literal zeros for a post whose insights have not been
      // computed yet, which for a fresh reel means 0% skip rate and 0s watch
      // time: the best possible numbers, from missing data. Views without reach
      // is the tell, since reach cannot be zero once anyone has seen it.
      const insightsPending = views > 0 && reach === 0;

      const watchMs = insightsPending ? null : num(r.media_reel_avg_watch_time);
      const totalWatchMs = insightsPending ? null : num(r.media_reel_total_watch_time);
      const skip = insightsPending ? null : num(r.media_reel_skip_rate);
      return {
        platform: "instagram",
        id: r.media_id,
        title: trimTitle(r.media_caption, r.media_shortcode || r.media_id),
        url: r.media_permalink || null,
        thumbnail: r.media_thumbnail_url || null,
        date: r.date
          ? String(r.date).slice(0, 10)
          : r.timestamp
            ? String(r.timestamp).slice(0, 10)
            : null,
        publishedAt: instant(r.timestamp),
        format: r.media_product_type || r.media_type || null,
        length: null,
        views,
        engagedViews: null,
        reach: insightsPending ? null : reach,
        likes,
        comments,
        shares,
        saves,
        followsGained: null, // not supported for reels
        minutesWatched: totalWatchMs !== null ? totalWatchMs / 60000 : null,
        avgWatchSeconds: watchMs !== null ? watchMs / 1000 : null,
        avgViewPercent: null, // YouTube-only
        skipRate: skip !== null ? skip * 100 : null, // stored upstream as a fraction
        insightsPending,
        engagement: likes + comments + shares + saves,
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // ---------- Daily series, merged on date ----------
  const dailyMap = new Map();
  const touch = (d) => {
    if (!dailyMap.has(d)) {
      dailyMap.set(d, {
        date: d,
        youtube: null,
        instagram: null,
        ytMinutes: null,
        igReach: null,
        igEngaged: null,
        igNewFollowers: null,
        // Views by who watched: Instagram follow type (UNKNOWN kept apart here,
        // counted with non-followers by the UI) and YouTube subscribed status.
        igViewsFollower: null,
        igViewsNonFollower: null,
        igViewsUnknown: null,
        ytViewsSubscribed: null,
        ytViewsUnsubscribed: null,
        // Instagram's own follows and unfollows that day: a true net.
        igFollows: null,
        igUnfollows: null,
      });
    }
    return dailyMap.get(d);
  };
  for (const r of dedupe(raw.yt_daily, "date")) {
    if (!r.date) continue;
    const e = touch(String(r.date).slice(0, 10));
    e.youtube = num(r.views);
    e.ytMinutes = num(r.estimated_minutes_watched);
  }
  for (const r of dedupe(raw.ig_daily, "date")) {
    if (!r.date) continue;
    const e = touch(String(r.date).slice(0, 10));
    e.instagram = num(r.views);
    e.igReach = num(r.reach_1d);
    e.igEngaged = num(r.accounts_engaged);
    e.igViewsFollower = num(r.views_follower);
    e.igViewsNonFollower = num(r.views_non_follower);
    e.igViewsUnknown = num(r.views_unknown);
  }
  for (const r of dedupe(raw.yt_subscribed_daily, "date")) {
    if (!r.date) continue;
    const e = touch(String(r.date).slice(0, 10));
    e.ytViewsSubscribed = num(r.subscribed_views);
    e.ytViewsUnsubscribed = num(r.unsubscribed_views);
  }
  for (const r of dedupe(raw.ig_follows_daily, "date")) {
    if (!r.date || num(r.follows) === null || num(r.unfollows) === null) continue;
    const e = touch(String(r.date).slice(0, 10));
    e.igFollows = num(r.follows);
    e.igUnfollows = num(r.unfollows);
  }
  // Instagram's follower_count is new followers gained that day (gross adds, not
  // net of unfollows), and comes from its own narrower-window query. Kept
  // separate from YouTube's net gained-minus-lost so the two are never plotted
  // as the same measure.
  for (const r of dedupe(raw.ig_followers_daily, "date")) {
    if (!r.date) continue;
    touch(String(r.date).slice(0, 10)).igNewFollowers = num(r.follower_count);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ---------- YouTube follower series ----------
  const subsDaily = dedupe(raw.yt_subs_daily, "date")
    .filter((r) => r.date)
    .map((r) => ({
      date: String(r.date).slice(0, 10),
      gained: num(r.subscribers_gained_channel) || 0,
      lost: num(r.subscribers_lost_channel) || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  /**
   * Walks a current follower total backwards through per-day changes to
   * reconstruct the level on each earlier date. Neither platform returns
   * historical follower counts, and snapshots only start the day this dashboard
   * is deployed, so without this the audience chart is blank for weeks.
   *
   * Fidelity differs by platform and the caller must say so:
   *  - YouTube supplies gained AND lost, so the walk uses true net change.
   *  - Instagram's follows_and_unfollows gives a true net (follows minus
   *    unfollows) for the days the details function has fetched. Before
   *    those, only follower_count's gross adds exist, so the walk subtracts
   *    more than actually accrued: earlier levels read too low and growth
   *    looks steeper than it was. Those days are an estimate.
   */
  function walkBack(current, changesByDate, timeline) {
    if (!changesByDate.size || !current || !timeline.length) return new Map();
    // Both platforms only return rows for days that saw movement, so a date with
    // no row means no change, not missing data. The timeline is clipped to the
    // earliest date the source actually covers: extending a flat line back
    // beyond that would assert stability we cannot observe.
    const earliest = [...changesByDate.keys()].sort()[0];
    const dates = timeline.filter((d) => d >= earliest).sort();
    if (!dates.length) return new Map();
    const levels = new Map();
    let level = current;
    for (let i = dates.length - 1; i >= 0; i--) {
      const date = dates[i];
      levels.set(date, level);
      level -= changesByDate.get(date) || 0;
      if (level < 0) level = 0;
    }
    return levels;
  }

  const ytChanges = new Map(subsDaily.map((s) => [s.date, s.gained - s.lost]));
  const igChanges = new Map(
    daily.filter((p) => p.igNewFollowers !== null).map((p) => [p.date, p.igNewFollowers])
  );
  // A measured net replaces the gross adds wherever Instagram reported one.
  for (const p of daily) {
    if (p.igFollows !== null && p.igUnfollows !== null) igChanges.set(p.date, p.igFollows - p.igUnfollows);
  }
  const timeline = daily.map((p) => p.date);
  const ytLevels = walkBack(num(ytChannel.subscriber_count) || 0, ytChanges, timeline);
  const igLevels = walkBack(num(igProfile.followers_count) || 0, igChanges, timeline);

  const derivedDates = [...new Set([...ytLevels.keys(), ...igLevels.keys()])].sort();
  const derivedHistory = derivedDates.map((date) => ({
    date,
    youtube: ytLevels.has(date) ? ytLevels.get(date) : null,
    instagram: igLevels.has(date) ? igLevels.get(date) : null,
  }));

  const content = [...ytVideos, ...igMedia].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "")
  );

  /**
   * Same cut posted to both platforms within a day of each other, so publish
   * time is the join key with a one-day tolerance. This is a heuristic, not an
   * identifier: two unrelated posts made a day apart would be merged. Each group
   * therefore carries its constituent pieces so a wrong pairing stays visible
   * rather than disappearing inside a total.
   *
   * Combined views sum two differently-defined metrics (see the note on the
   * views chart). Useful as a reach proxy across platforms; not a precise count.
   */
  const dayMs = 86400000;
  const asTime = (d) => new Date(d + "T00:00:00Z").getTime();

  // Pair each YouTube video with the nearest unpaired Instagram post within one
  // day. A strict same-date join misses anything posted late evening, where the
  // two platforms land either side of a UTC midnight: a reel published at 23:00
  // and its YouTube twin stamped 03:30 the next day are the same release.
  const igPool = igMedia.filter((m) => m.date).slice();
  const pairs = [];
  const pairedIg = new Set();
  for (const video of ytVideos.filter((v) => v.date)) {
    let best = null;
    let bestGap = Infinity;
    for (const media of igPool) {
      if (pairedIg.has(media.id)) continue;
      const gap = Math.abs(asTime(video.date) - asTime(media.date));
      if (gap <= dayMs && gap < bestGap) {
        best = media;
        bestGap = gap;
      }
    }
    if (best) pairedIg.add(best.id);
    pairs.push(best ? [video, best] : [video]);
  }
  for (const media of igPool) {
    if (!pairedIg.has(media.id)) pairs.push([media]);
  }

  const groupMap = new Map();
  for (const group of pairs) {
    // Date the release by its earliest piece.
    const date = group.map((p) => p.date).sort()[0];
    if (!date) continue;
    const key = group.map((p) => p.id).join("|");
    groupMap.set(key, {
      date,
      title: null,
      platforms: [],
      pieces: [],
      views: 0,
      engagement: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      reach: null,
    });
    const g = groupMap.get(key);
    for (const item of group) {
      g.pieces.push(item);
      if (!g.platforms.includes(item.platform)) g.platforms.push(item.platform);
      g.views += item.views || 0;
      g.engagement += item.engagement || 0;
      g.likes += item.likes || 0;
      g.comments += item.comments || 0;
      g.shares += item.shares || 0;
      g.saves += item.saves || 0;
      if (item.reach !== null) g.reach = (g.reach || 0) + item.reach;
      // Prefer the YouTube title: Instagram captions often open with a hook,
      // hashtags or a call to action rather than naming the piece.
      if (!g.title || item.platform === "youtube") g.title = item.title;
    }
  }
  const combined = [...groupMap.values()]
    .map((g) => ({
      ...g,
      crossPosted: g.platforms.length > 1,
      youtubeViews: g.pieces
        .filter((p) => p.platform === "youtube")
        .reduce((a, p) => a + (p.views || 0), 0),
      instagramViews: g.pieces
        .filter((p) => p.platform === "instagram")
        .reduce((a, p) => a + (p.views || 0), 0),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const ytTotals = {
    followers: num(ytChannel.subscriber_count) || 0,
    posts: num(ytChannel.video_count) || 0,
    lifetimeViews: num(ytChannel.view_count) || 0,
    periodViews: sum(ytVideos.map((v) => v.views)),
    engagement: sum(ytVideos.map((v) => v.engagement)),
    title: ytChannel.channel_title || "YouTube",
    image: ytChannel.channel_image || null,
  };
  const igTotals = {
    followers: num(igProfile.followers_count) || 0,
    posts: num(igProfile.media_count) || 0,
    lifetimeViews: sum(igMedia.map((m) => m.views)),
    periodViews: sum(igMedia.map((m) => m.views)),
    engagement: sum(igMedia.map((m) => m.engagement)),
    title: igProfile.name || igProfile.username || "Instagram",
    handle: igProfile.username || null,
    following: num(igProfile.follows_count) || 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      followers: ytTotals.followers + igTotals.followers,
      posts: content.length,
      views: ytTotals.periodViews + igTotals.periodViews,
      engagement: ytTotals.engagement + igTotals.engagement,
    },
    youtube: {
      ...ytTotals,
      videos: ytVideos,
      trafficDaily: (raw.yt_traffic || [])
        .filter((r) => r.date && r.traffic_source)
        .map((r) => ({
          date: String(r.date).slice(0, 10),
          label: r.traffic_source,
          value: num(r.views) || 0,
        })),
      // Per-second retention, only available on the direct API path. Grouped by
      // video and joined to the title so the UI can offer a picker.
      retention: (() => {
        const byVideo = new Map();
        for (const r of raw.yt_retention || []) {
          if (!r.video) continue;
          if (!byVideo.has(r.video)) byVideo.set(r.video, []);
          byVideo.get(r.video).push({
            elapsed: num(r.elapsed_ratio),
            watchRatio: num(r.watch_ratio),
            relative: num(r.relative_performance),
          });
        }
        const titles = new Map(ytVideos.map((v) => [v.id, v]));
        return [...byVideo.entries()]
          .filter(([id]) => titles.has(id))
          .map(([id, points]) => {
            const v = titles.get(id);
            // relativeRetentionPerformance compares each moment with every
            // YouTube video of similar length: 0.5 is typical, 1 the best.
            // Its average over the curve is the one-number summary.
            const rel = points.map((p) => p.relative).filter((x) => x !== null);
            return {
              video: id,
              title: v.title,
              url: v.url,
              views: v.views,
              date: v.date,
              relativeAvg: rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : null,
              points: points.sort((a, b) => a.elapsed - b.elapsed),
            };
          })
          .sort((a, b) => b.views - a.views);
      })(),
      geoByWindow: {
        14: breakdown(raw.yt_geo_14, "country", "views", 10),
        30: breakdown(raw.yt_geo_30, "country", "views", 10),
        90: breakdown(raw.yt_geo_90, "country", "views", 10),
      },
      age: breakdown(raw.yt_age, "viewer_age_group", "viewer_percentage", 10),
      gender: breakdown(raw.yt_gender, "viewer_gender", "viewer_percentage", 5),
      subsDaily,
    },
    instagram: {
      ...igTotals,
      media: igMedia,
      geo: breakdown(raw.ig_geo, "audience_country_name", "audience_country_size", 10),
      age: breakdown(raw.ig_age, "audience_age_name", "audience_age_size", 10),
      gender: breakdown(raw.ig_gender, "audience_gender_name", "audience_gender_size", 5),
    },
    daily,
    derivedHistory,
    content,
    combined,
  };
}
