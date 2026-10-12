import type { Config } from "@netlify/functions";
import { env } from "../lib/env.mjs";

// Cron entry point for post details (schedule in netlify.toml). Scheduled
// functions get 30 seconds and background functions cannot be scheduled, so
// this only hands off to details-background, which has 15 minutes.
export default async () => {
  const origin = env("URL") || env("DEPLOY_PRIME_URL");
  if (!origin) {
    console.error("[details-tick] no site URL available; cannot reach the details function");
    return;
  }
  const res = await fetch(`${origin}/.netlify/functions/details-background`, {
    method: "POST",
    headers: { "x-dash-key": env("DASH_KEY") || "" },
  });
  // Background functions answer 202 immediately; anything else means the
  // handoff failed and nothing runs this tick.
  if (res.status !== 202) {
    console.error(`[details-tick] handoff returned ${res.status}, expected 202`);
  }
};

export const config: Config = {};
