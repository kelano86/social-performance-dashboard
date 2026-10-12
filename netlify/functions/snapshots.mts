import type { Config, Context } from "@netlify/functions";
import { store } from "../lib/refresh.mjs";
import { gateRead } from "../lib/auth.mjs";
import { readSeries, readDay, dashTz } from "../lib/snapshots.mjs";

// Read side of the view snapshots, kept off /api/data so that payload does not
// grow with history:
//   ?platform=instagram|youtube&id=<id>  one post's views over time
//   ?day=YYYY-MM-DD                      views gained that day (DASH_TZ), both platforms
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Snapshots only change on refresh. Private: the response is gated.
      ...(status === 200 ? { "cache-control": "private, max-age=300" } : {}),
    },
  });

export default async (req: Request, _context: Context) => {
  const denied = gateRead(req);
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const tz = dashTz();
  try {
    const day = params.get("day");
    if (day !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day must be YYYY-MM-DD" }, 400);
      return json(await readDay(store(), day, tz));
    }
    const platform = params.get("platform") || "";
    const id = params.get("id") || "";
    if (!["instagram", "youtube"].includes(platform) || !/^[\w-]{1,64}$/.test(id)) {
      return json({ error: "expected ?platform=instagram|youtube&id=<id>, or ?day=YYYY-MM-DD" }, 400);
    }
    return json(await readSeries(store(), platform, id, tz));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = {
  path: "/api/snapshots",
};
