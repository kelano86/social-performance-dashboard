// Instagram account-level daily history, cached in Netlify Blobs.
//
// Instagram only returns a time series for reach and follower_count. Daily
// views (with their follower / non-follower split) and follows_and_unfollows
// are one request per day each, so 90 days of them is 180 requests. Days stop
// changing a few days after they end, so finished days are stored here and
// only the days not yet stored, plus the last RECENT_DAYS (which Instagram
// still revises), are ever requested again.
//
// Ownership: the details background function is the only writer (it has 15
// minutes and does the backfill). The scheduled refresh only reads, so a cold
// cache can never push it past its 30 second budget.
//
// In the social-dashboard store:
//   ig-daily/YYYY-MM  { days: { "YYYY-MM-DD": { views, viewsSplit, follows, unfollows, at } } }
//     viewsSplit  { follower, nonFollower, unknown } or null when not reported
//     follows / unfollows  numbers, or null when the day was fetched but could
//                          not be split; absent when never fetched
//
// Everything here takes the store as an argument, so it runs unchanged against
// Netlify Blobs and the test stub.

export const IG_DAILY_PREFIX = "ig-daily/";
// Instagram revises the most recent days, so these are always re-requested.
export const RECENT_DAYS = 3;
// The refresh waits at most this long for the cache before carrying on without
// it (fetching every day plain, exactly as before the cache existed).
const REFRESH_READ_BUDGET_MS = 3000;

const monthOf = (date) => IG_DAILY_PREFIX + String(date).slice(0, 7);

export function monthKeysFor(dates) {
  return [...new Set(dates.map(monthOf))].sort();
}

/** Every cached day in the months the given dates touch, as a Map of date -> record. */
export async function readIgDaily(s, dates) {
  const keys = monthKeysFor(dates);
  const blobs = await Promise.all(keys.map((k) => s.get(k, { type: "json" })));
  const days = new Map();
  for (const blob of blobs) {
    for (const [date, rec] of Object.entries(blob?.days || {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && rec && typeof rec === "object") days.set(date, rec);
    }
  }
  return days;
}

/**
 * Merges `updates` (date -> partial record) into the cached months and writes
 * only the months that changed. Returns the keys written.
 */
export async function writeIgDaily(s, cached, updates) {
  if (!updates.size) return [];
  const byMonth = new Map();
  for (const [date, rec] of cached) {
    const k = monthOf(date);
    if (!byMonth.has(k)) byMonth.set(k, {});
    byMonth.get(k)[date] = rec;
  }
  const touched = new Set();
  for (const [date, fields] of updates) {
    const k = monthOf(date);
    if (!byMonth.has(k)) byMonth.set(k, {});
    const month = byMonth.get(k);
    month[date] = { ...(month[date] || {}), ...fields };
    cached.set(date, month[date]);
    touched.add(k);
  }
  const keys = [...touched].sort();
  await Promise.all(keys.map((k) => s.setJSON(k, { days: byMonth.get(k) })));
  return keys;
}

/**
 * The refresh's read: resolves to { days, error } and never rejects. Started
 * before the platform pulls so the blob round trip overlaps them; a slow or
 * failing store degrades to an empty cache plus a warning.
 */
export function igDailyForRefresh(s, dates, budgetMs = REFRESH_READ_BUDGET_MS) {
  let timer;
  return Promise.race([
    readIgDaily(s, dates).then((days) => ({ days, error: null })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ days: new Map(), error: `read timed out after ${budgetMs}ms` }), budgetMs);
    }),
  ])
    .catch((err) => ({ days: new Map(), error: err?.message || String(err) }))
    .finally(() => clearTimeout(timer));
}
