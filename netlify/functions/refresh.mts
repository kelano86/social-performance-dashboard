import type { Config } from "@netlify/functions";
import { doRefresh } from "../lib/refresh.mjs";

// Scheduled pull. The cron lives in netlify.toml so every schedule is in one place.
// Scheduled functions only run on published production deploys.
export default async (req: Request) => {
  let nextRun: string | undefined;
  try {
    const body = await req.json();
    nextRun = body?.next_run;
  } catch {
    // Manual `netlify functions:invoke` sends no body. Not an error.
  }

  try {
    const dataset = await doRefresh();
    console.log(
      `[refresh] ok in ${dataset.durationMs}ms · ${dataset.content.length} items · ` +
        `${dataset.warnings.length} warning(s) · next run ${nextRun ?? "unknown"}`
    );
    if (dataset.warnings.length) {
      for (const w of dataset.warnings) console.warn(`[refresh] optional query degraded: ${w}`);
    }
  } catch (err) {
    // Throwing marks the scheduled run failed in Netlify's UI, which is what we want:
    // the previously cached dataset stays served rather than being replaced with junk.
    console.error("[refresh] FAILED:", err instanceof Error ? err.message : err);
    throw err;
  }
};

export const config: Config = {};
