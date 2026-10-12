import type { Config, Context } from "@netlify/functions";
import { doRefresh } from "../lib/refresh.mjs";
import { gateWrite } from "../lib/auth.mjs";

// On-demand refresh, for the dashboard's refresh button.
// Always gated: an open trigger would let anyone burn the API quotas.
export default async (req: Request, _context: Context) => {
  const denied = gateWrite(req);
  if (denied) return denied;

  try {
    const dataset = await doRefresh();
    return new Response(
      JSON.stringify({
        ok: true,
        generatedAt: dataset.generatedAt,
        durationMs: dataset.durationMs,
        items: dataset.content.length,
        warnings: dataset.warnings,
        rowCounts: dataset.rowCounts,
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/refresh",
};
