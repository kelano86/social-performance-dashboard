/**
 * One-time credential setup for the direct platform APIs.
 *
 *   node scripts/setup-tokens.mjs google            read-only YouTube access (stats)
 *   node scripts/setup-tokens.mjs google --upload   the same, plus youtube.upload (Schedule tab)
 *   node scripts/setup-tokens.mjs meta              60 day Instagram token
 *   node scripts/setup-tokens.mjs check             which values .env.local has (masked)
 *
 * Tokens are written to .env.local (gitignored) and never printed. Copy them
 * from that file into Netlify yourself. Nothing here echoes a secret to stdout.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, "../.env.local");
const REDIRECT_PORT = 5320;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Read-only scopes are all the dashboard needs. The Schedule tab's YouTube
// half also needs youtube.upload, requested only with --upload.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
const GOOGLE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

// ---------------------------------------------------------------- env file
function readEnvLocal() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function writeEnvLocal(updates) {
  const current = readEnvLocal();
  const merged = { ...current, ...updates };
  const body =
    "# Local credentials. Gitignored. Copy these into Netlify env vars.\n" +
    "# Never commit this file or paste its contents into a chat.\n" +
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  writeEnvLocal.lastKeys = Object.keys(updates);
  writeFileSync(ENV_FILE, body, { mode: 0o600 });
}

const mask = (v) => (v ? `set (${v.length} chars)` : "missing");

// ---------------------------------------------------------------- google
async function google() {
  const cfg = readEnvLocal();
  const clientId = cfg.GOOGLE_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "\nBefore running this, put your OAuth client details in .env.local:\n\n" +
        "  GOOGLE_CLIENT_ID=...\n  GOOGLE_CLIENT_SECRET=...\n\n" +
        "Get them from Google Cloud Console:\n" +
        "  1. Create (or pick) a project\n" +
        "  2. Enable 'YouTube Data API v3' and 'YouTube Analytics API'\n" +
        "  3. OAuth consent screen: External. Publish it to production (refresh tokens\n" +
        "     from an app left in Testing expire after 7 days)\n" +
        "  4. Credentials > Create OAuth client ID > Web application\n" +
        `  5. Add this Authorised redirect URI exactly: ${REDIRECT_URI}\n`
    );
    process.exit(1);
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  const scopes = process.argv.includes("--upload") ? [...GOOGLE_SCOPES, GOOGLE_UPLOAD_SCOPE] : GOOGLE_SCOPES;
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  // Without this an already-authorised app returns no refresh token.
  authUrl.searchParams.set("prompt", "consent");

  console.log(`\nRedirect URI this script uses (must be listed on the OAuth client): ${REDIRECT_URI}`);
  console.log(`Scopes requested: ${scopes.map((s) => s.split("/").pop()).join(", ")}`);
  console.log("\nOpen this URL, sign in with the Google account that owns the channel, and grant access:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for the redirect...\n");

  const code = await new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<body style="font-family:system-ui;background:#0a0a0a;color:#f5f0e8;padding:60px">
         <h2>${err ? "Authorisation failed" : "Authorised"}</h2>
         <p>${err ? err : "You can close this tab and return to the terminal."}</p></body>`
      );
      server.close();
      if (err) reject(new Error(err));
      else resolvePromise(got);
    });
    server.listen(REDIRECT_PORT);
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for authorisation"));
    }, 300000);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    console.error("Token exchange failed:", body.error || res.status, body.error_description || "");
    if (res.ok && !body.refresh_token) {
      console.error("No refresh_token returned. Revoke the app's access and retry so consent is re-prompted.");
    }
    process.exit(1);
  }

  writeEnvLocal({ GOOGLE_REFRESH_TOKEN: body.refresh_token });
  console.log(`Refresh token acquired and written to .env.local (${body.refresh_token.length} chars).`);
  console.log("It was not printed here. Copy it from that file into Netlify.");
}

// ---------------------------------------------------------------- meta
async function meta() {
  const cfg = readEnvLocal();
  const appId = cfg.META_APP_ID;
  const appSecret = cfg.META_APP_SECRET;
  const shortToken = cfg.META_SHORT_TOKEN;

  if (!appId || !appSecret || !shortToken) {
    console.error(
      "\nBefore running this, put these in .env.local:\n\n" +
        "  META_APP_ID=...\n  META_APP_SECRET=...\n  META_SHORT_TOKEN=...\n\n" +
        "To get the short-lived token:\n" +
        "  1. developers.facebook.com > your app > Tools > Graph API Explorer\n" +
        "  2. Pick your app, then 'Generate Access Token'\n" +
        "  3. Grant: instagram_basic, instagram_manage_insights,\n" +
        "     pages_read_engagement, pages_show_list\n" +
        "     (plus instagram_content_publish if you will use the Schedule tab)\n" +
        "  4. Copy the token into META_SHORT_TOKEN\n\n" +
        "That token lasts about an hour. This script exchanges it for a 60 day one.\n"
    );
    process.exit(1);
  }

  // Try the Instagram Login exchange first, then Facebook Login. Which one
  // applies depends on how the app was configured, and the error from the wrong
  // one is unhelpful, so both are attempted rather than guessed at.
  let body = null;
  let mode = null;

  const igUrl = new URL("https://graph.instagram.com/access_token");
  igUrl.searchParams.set("grant_type", "ig_exchange_token");
  igUrl.searchParams.set("client_secret", appSecret);
  igUrl.searchParams.set("access_token", shortToken);
  let res = await fetch(igUrl);
  if (res.ok) {
    body = await res.json();
    mode = "instagram";
  } else {
    const fbUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    fbUrl.searchParams.set("grant_type", "fb_exchange_token");
    fbUrl.searchParams.set("client_id", appId);
    fbUrl.searchParams.set("client_secret", appSecret);
    fbUrl.searchParams.set("fb_exchange_token", shortToken);
    res = await fetch(fbUrl);
    body = await res.json().catch(() => ({}));
    mode = "facebook";
  }

  if (!res.ok || !body?.access_token) {
    console.error("Exchange failed on both configurations.");
    console.error("  last error:", body?.error?.message || res.status);
    console.error("  Check that META_APP_SECRET matches the app the short token came from.");
    process.exit(1);
  }
  console.log(`Detected configuration: ${mode} login.`);

  const days = body.expires_in ? Math.round(body.expires_in / 86400) : "unknown";
  writeEnvLocal({ META_ACCESS_TOKEN: body.access_token, META_SHORT_TOKEN: "", META_AUTH: mode });
  console.log(`Long-lived token acquired, valid ~${days} days. Written to .env.local.`);
  console.log("It was not printed here. Copy it from that file into Netlify.");
}

// ---------------------------------------------------------------- check
async function check() {
  const cfg = readEnvLocal();
  console.log("\n.env.local contents (masked):\n");
  for (const k of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "META_APP_ID",
    "META_APP_SECRET",
    "META_ACCESS_TOKEN",
    "META_AUTH",
    "IG_USER_ID",
  ]) {
    console.log(`  ${k.padEnd(22)} ${mask(cfg[k])}`);
  }
  console.log("");
}

const cmd = process.argv[2];
if (cmd === "google") await google();
else if (cmd === "meta") await meta();
else if (cmd === "check") await check();
else {
  console.log("Usage: node scripts/setup-tokens.mjs [google [--upload] | meta | check]");
  process.exit(1);
}
