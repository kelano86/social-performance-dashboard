import { getStore, getDeployStore } from "@netlify/blobs";
import { collect } from "./sources.mjs";
import { shape } from "./shape.mjs";
import { recordSnapshots } from "./snapshots.mjs";
import { igDailyForRefresh } from "./igdaily.mjs";
import { dailyWindow, metaConfigured } from "./meta.mjs";

export const STORE_NAME = "social-dashboard";
export const LATEST_KEY = "latest";
export const HISTORY_KEY = "history";

/**
 * Keep production data out of deploy-preview runs.
 */
export function store() {
  const ctx = globalThis.Netlify?.context?.deploy?.context;
  return ctx === "production" || ctx === undefined
    ? getStore({ name: STORE_NAME, consistency: "strong" })
    : getDeployStore({ name: STORE_NAME, consistency: "strong" });
}

/**
 * Follower counts are a today-only snapshot upstream (neither API returns a
 * historical follower count), so the only way to ever plot
 * follower growth is to record it ourselves on every refresh. One row per day,
 * last write of the day wins.
 */
function appendHistory(previous, dataset) {
  const rows = Array.isArray(previous) ? previous.slice() : [];
  const today = dataset.generatedAt.slice(0, 10);
  const entry = {
    date: today,
    ytFollowers: dataset.youtube.followers,
    igFollowers: dataset.instagram.followers,
    ytLifetimeViews: dataset.youtube.lifetimeViews,
    igViews: dataset.instagram.lifetimeViews,
    totalEngagement: dataset.totals.engagement,
  };
  const i = rows.findIndex((r) => r.date === today);
  if (i >= 0) rows[i] = entry;
  else rows.push(entry);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  // Two years of daily rows is a trivial blob; cap it anyway.
  return rows.slice(-800);
}

// Snapshot blob calls normally take well under a second. This only stops a
// stuck store from pushing the whole refresh past its 30 s budget.
const SNAPSHOT_BUDGET_MS = 6000;

/** Recording views must never fail the refresh: any problem becomes a warning. */
async function snapshotsOrWarning(s, dataset, raw, warnings) {
  let timer;
  try {
    return await Promise.race([
      recordSnapshots(s, dataset, raw),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${SNAPSHOT_BUDGET_MS}ms`)), SNAPSHOT_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    warnings.push(`view snapshots: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function doRefresh() {
  const started = Date.now();
  const s = store();
  // Read-only, started first so the blob round trip overlaps the pulls. The
  // details background function fills it; the refresh never writes it.
  const igDaily = metaConfigured() ? igDailyForRefresh(s, dailyWindow()) : null;
  const { raw, warnings, sources, tokenStatus } = await collect({ igDaily });
  const dataset = shape(raw);
  dataset.sources = sources;
  dataset.tokenStatus = tokenStatus;

  const [previousHistory, snapshots] = await Promise.all([
    s.get(HISTORY_KEY, { type: "json" }),
    snapshotsOrWarning(s, dataset, raw, warnings),
  ]);
  const history = appendHistory(previousHistory, dataset);

  dataset.history = history;
  dataset.snapshots = snapshots;
  dataset.warnings = warnings;
  dataset.durationMs = Date.now() - started;
  dataset.rowCounts = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );

  await s.setJSON(LATEST_KEY, dataset);
  await s.setJSON(HISTORY_KEY, history);

  return dataset;
}
