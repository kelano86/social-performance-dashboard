/**
 * Soft access gate.
 *
 * The dashboard exposes private analytics (reach, saves, audience demographics),
 * so a bare public URL would hand that to anyone who found it. DASH_KEY is a
 * shared passphrase checked server-side before any data is returned.
 *
 * This is a deterrent, not authentication: there are no accounts, no rate
 * limiting, and the key travels in a header. It stops a leaked URL from being
 * readable. It is not what you would put in front of client data.
 *
 * If DASH_KEY is unset, reads are open (useful for a throwaway deploy) but
 * manual refresh is always refused, so nobody can burn API quota remotely.
 */
import { env } from "./env.mjs";

function configuredKey() {
  return env("DASH_KEY");
}

function presentedKey(req) {
  const header = req.headers.get("x-dash-key");
  if (header) return header;
  try {
    return new URL(req.url).searchParams.get("k") || "";
  } catch {
    return "";
  }
}

/** Constant-time-ish compare. Not a security boundary, but avoids the trivial leak. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function gateRead(req) {
  const expected = configuredKey();
  if (!expected) return null; // open by configuration
  if (same(expected, presentedKey(req))) return null;
  return new Response(JSON.stringify({ error: "unauthorised", needsKey: true }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function gateWrite(req) {
  const expected = configuredKey();
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "manual refresh disabled: DASH_KEY is not set on this site" }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }
  if (same(expected, presentedKey(req))) return null;
  return new Response(JSON.stringify({ error: "unauthorised", needsKey: true }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
