/**
 * Environment access.
 *
 * Netlify's own guidance is to use `Netlify.env.get`, and that is tried first.
 * `process.env` is kept as a fallback because the Netlify global is not
 * populated in every bundling path, and an env var silently reading as unset is
 * how an access gate quietly stops gating.
 */
export function env(name) {
  try {
    const viaNetlify = globalThis.Netlify?.env?.get(name);
    if (viaNetlify) return viaNetlify;
  } catch {
    /* Netlify global absent */
  }
  try {
    if (typeof process !== "undefined" && process.env && process.env[name]) {
      return process.env[name];
    }
  } catch {
    /* no process */
  }
  return "";
}

/** Diagnostic only: reports presence, never values. */
export function envDiagnostic(names) {
  const out = {
    netlifyGlobalPresent: typeof globalThis.Netlify !== "undefined",
    netlifyEnvPresent: typeof globalThis.Netlify?.env?.get === "function",
    processEnvPresent: typeof process !== "undefined" && !!process.env,
    vars: {},
  };
  for (const n of names) {
    let viaNetlify = false;
    try {
      viaNetlify = !!globalThis.Netlify?.env?.get(n);
    } catch {
      /* ignore */
    }
    out.vars[n] = {
      viaNetlify,
      viaProcess: !!(typeof process !== "undefined" && process.env && process.env[n]),
    };
  }
  return out;
}
