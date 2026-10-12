import type { Config } from "@netlify/functions";
import { readSchedule } from "../lib/store.mjs";
import { env } from "../lib/env.mjs";

// Cron entry point. Instagram has no native scheduling, so this is what makes a
// scheduled reel actually go out. It only decides whether anything is due and
// then hands off: the real work needs more than 30 seconds.
export default async () => {
  const now = Date.now();
  const items = await readSchedule();
  const due = items.filter(
    (it) => it.status === "scheduled" && Date.parse(it.scheduledAt) <= now && (it.attempts || 0) < 3
  );

  if (!due.length) return;

  const origin = env("URL") || env("DEPLOY_PRIME_URL");
  if (!origin) {
    console.error("[tick] no site URL available; cannot reach the publisher");
    return;
  }

  console.log(`[tick] ${due.length} item(s) due, invoking publisher`);
  const res = await fetch(`${origin}/.netlify/functions/publish-run-background`, {
    method: "POST",
    headers: { "x-dash-key": env("DASH_KEY") || "" },
  });
  // Background functions answer 202 immediately; anything else means the
  // handoff failed and nothing will publish this tick.
  if (res.status !== 202) {
    console.error(`[tick] publisher handoff returned ${res.status}, expected 202`);
  }
};

export const config: Config = {};
