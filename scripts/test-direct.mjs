/**
 * Verifies the direct platform clients against the real APIs, using .env.local.
 *
 *   node scripts/test-direct.mjs            both platforms
 *   node scripts/test-direct.mjs google     YouTube only
 *   node scripts/test-direct.mjs meta       Instagram only
 *
 * Prints row counts, timings and a few sample values, so you can check your
 * credentials work and that a full pull fits inside Netlify's 30 second
 * scheduled-function budget before deploying. Never prints credentials.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, "../.env.local");

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const which = process.argv[2] || "both";
const { fetchYouTube, googleConfigured } = await import("../netlify/lib/google.mjs");
const { fetchInstagram, metaConfigured, inspectToken } = await import("../netlify/lib/meta.mjs");
const { shape } = await import("../netlify/lib/shape.mjs");

const raw = {};
const warnings = [];

if (which === "both" || which === "google") {
  if (!googleConfigured()) {
    console.error("Google not configured. Run: node scripts/setup-tokens.mjs google");
  } else {
    const t = Date.now();
    const res = await fetchYouTube();
    Object.assign(raw, res.raw);
    warnings.push(...res.warnings);
    console.log(`\nYouTube fetched in ${Date.now() - t}ms`);
    for (const [k, v] of Object.entries(res.raw)) {
      console.log(`  ${k.padEnd(16)} ${Array.isArray(v) ? v.length : "?"} rows`);
    }
    const retention = res.raw.yt_retention || [];
    if (retention.length) {
      const first = retention[0].video;
      const curve = retention.filter((r) => r.video === first);
      console.log(`  retention curve for ${first}: ${curve.length} points`);
      console.log(
        "    sample:",
        curve.slice(0, 4).map((p) => `${Math.round(p.elapsed_ratio * 100)}%->${(p.watch_ratio ?? 0).toFixed(2)}`).join("  ")
      );
    }
  }
}

if (which === "both" || which === "meta") {
  if (!metaConfigured()) {
    console.error("Meta not configured. Run: node scripts/setup-tokens.mjs meta");
  } else {
    const status = await inspectToken(process.env.META_ACCESS_TOKEN);
    if (status) {
      console.log(
        `\nMeta token: ${status.neverExpires ? "does not expire" : `${status.daysLeft} days left (expires ${status.expiresAt})`}`
      );
    }
    const t = Date.now();
    const res = await fetchInstagram();
    Object.assign(raw, res.raw);
    warnings.push(...res.warnings);
    console.log(`Instagram fetched in ${Date.now() - t}ms (ig user ${res.igId})`);
    for (const [k, v] of Object.entries(res.raw)) {
      console.log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.length : "?"} rows`);
    }
  }
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log("  ! " + w);
}

if (Object.keys(raw).length) {
  const dataset = shape(raw);
  console.log("\nShaped:");
  console.log("  followers (blended):", dataset.totals.followers);
  console.log("  content items:      ", dataset.content.length);
  console.log("  combined releases:  ", dataset.combined.length);
  console.log("  daily points:       ", dataset.daily.length);
  console.log("  youtube videos:     ", dataset.youtube.videos.length);
  console.log("  instagram media:    ", dataset.instagram.media.length);

  const outDir = resolve(here, "../.local");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "direct.json"), JSON.stringify(dataset, null, 2));
  console.log("\nWritten to .local/direct.json (gitignored). Contains your real numbers: keep it local.");
}
