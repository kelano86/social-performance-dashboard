import type { Config, Context } from "@netlify/functions";
import { store, LATEST_KEY } from "../lib/refresh.mjs";
import { gateRead } from "../lib/auth.mjs";

export default async (req: Request, _context: Context) => {
  const denied = gateRead(req);
  if (denied) return denied;

  const dataset = await store().get(LATEST_KEY, { type: "json" });

  if (!dataset) {
    return new Response(
      JSON.stringify({
        error: "no data cached yet",
        hint: "Trigger a refresh, or wait for the next scheduled run.",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify(dataset), {
    headers: {
      "content-type": "application/json",
      // The blob only changes on refresh; let the browser reuse it briefly.
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    },
  });
};

export const config: Config = {
  path: "/api/data",
};
