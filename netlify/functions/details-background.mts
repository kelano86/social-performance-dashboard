import type { Context } from "@netlify/functions";
import { store } from "../lib/refresh.mjs";
import { runDetails } from "../lib/details.mjs";
import { env } from "../lib/env.mjs";

// A background function (15 minutes, answers 202 immediately), started every 6
// hours by details-tick. It does the work the 30 second refresh has no room
// for: backfilling Instagram's daily views split and follows/unfollows into the
// ig-daily cache, and fetching per-post details for the Content tab's
// drop-downs into details/latest. See netlify/lib/details.mjs.
export default async (req: Request, _context: Context) => {
  // Not publicly triggerable: a stray request should not spend API quota.
  const key = env("DASH_KEY");
  if (key && req.headers.get("x-dash-key") !== key) {
    console.warn("[details] rejected an unauthenticated invocation");
    return;
  }
  try {
    const out = await runDetails(store());
    const daily = out.igDaily;
    console.log(
      `[details] ok in ${out.durationMs}ms · requests ig ${out.requests.instagram}, yt ${out.requests.youtube} · ` +
        `ig posts ${JSON.stringify(out.counts.instagram)} · yt videos ${JSON.stringify(out.counts.youtube)} · ` +
        `ig daily ${daily ? JSON.stringify(daily.requested) + " requested, " + daily.cachedDays + " days cached" : "none"} · ` +
        `${out.warnings.length} warning(s)`
    );
    for (const w of out.warnings) console.warn(`[details] ${w}`);
  } catch (err) {
    console.error("[details] FAILED:", err instanceof Error ? err.message : err);
  }
};
