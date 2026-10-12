import type { Config, Context } from "@netlify/functions";
import { store } from "../lib/refresh.mjs";
import { gateRead } from "../lib/auth.mjs";
import { readDetails } from "../lib/details.mjs";

// One post's details for its row drop-down on the Content tab, kept off
// /api/data so that payload does not grow with every post:
//   ?platform=instagram|youtube&id=<id>
// Written by details-background every 6 hours. An unknown id is a 200 with
// `details: null`, the same as a post not fetched yet.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Details only change every 6 hours. Private: the response is gated.
      ...(status === 200 ? { "cache-control": "private, max-age=300" } : {}),
    },
  });

export default async (req: Request, _context: Context) => {
  const denied = gateRead(req);
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const platform = params.get("platform") || "";
  const id = params.get("id") || "";
  if (!["instagram", "youtube"].includes(platform) || !/^[\w-]{1,64}$/.test(id)) {
    return json({ error: "expected ?platform=instagram|youtube&id=<id>" }, 400);
  }
  try {
    return json(await readDetails(store(), platform, id));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = {
  path: "/api/details",
};
