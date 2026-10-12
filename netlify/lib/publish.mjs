// Publishing to Instagram and YouTube.
//
// The two platforms need opposite handling:
//
//   Instagram has no scheduling. We hold the post and fire at the right minute.
//     Publishing is three steps: create a container pointing at a public video
//     URL, wait for Meta to finish transcoding, then publish. Publishing before
//     transcoding finishes fails, so the wait is mandatory, not defensive.
//
//   YouTube schedules natively. Upload once as private with status.publishAt and
//     Google releases it. Nothing of ours needs to be awake at the target time.

import { env } from "./env.mjs";
import { detectAuth } from "./meta.mjs";
import { getAccessToken } from "./google.mjs";

const FB_GRAPH = "https://graph.facebook.com";
const VERSION = "v21.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(path, params, method = "GET") {
  const url = new URL(`${FB_GRAPH}/${VERSION}/${path}`);
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const init = { method };
  if (method === "POST") {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body.set(k, v);
    }
    init.body = body;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Instagram: non-JSON response ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(`Instagram: ${parsed.error?.message || res.status}`);
  return parsed;
}

/**
 * Publishes a reel. `videoUrl` must be reachable by Meta's fetcher.
 * Returns the permalink.
 */
export async function publishInstagramReel({ videoUrl, caption, maxWaitMs = 600000 }) {
  const token = env("META_ACCESS_TOKEN");
  if (!token) throw new Error("META_ACCESS_TOKEN is not set");
  const auth = await detectAuth(token);

  const container = await graph(
    `${auth.igId}/media`,
    { media_type: "REELS", video_url: videoUrl, caption: caption || "", access_token: token },
    "POST"
  );
  if (!container.id) throw new Error("Instagram: container creation returned no id");

  // Meta transcodes asynchronously. Publishing an IN_PROGRESS container fails,
  // and ERROR carries the real reason (bad codec, aspect ratio, unreachable URL)
  // which is worth surfacing verbatim rather than as a generic failure.
  const startedAt = Date.now();
  let delay = 3000;
  for (;;) {
    const status = await graph(container.id, {
      fields: "status_code,status",
      access_token: token,
    });
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(
        `Instagram: container ${status.status_code}: ${status.status || "no detail given"}`
      );
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(
        `Instagram: video still ${status.status_code} after ${Math.round(maxWaitMs / 1000)}s`
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15000);
  }

  const published = await graph(
    `${auth.igId}/media_publish`,
    { creation_id: container.id, access_token: token },
    "POST"
  );
  if (!published.id) throw new Error("Instagram: publish returned no media id");

  const detail = await graph(published.id, { fields: "permalink", access_token: token });
  return { id: published.id, permalink: detail.permalink || null };
}

/**
 * Uploads to YouTube as private with a publishAt, letting YouTube do the
 * scheduling. Requires the youtube.upload scope, which is broader than the
 * read-only scopes the dashboard uses, so the refresh token must have been
 * granted with it (node scripts/setup-tokens.mjs google --upload).
 */
export async function publishYouTubeVideo({ videoUrl, title, description, publishAt, tags }) {
  const accessToken = await getAccessToken();

  const source = await fetch(videoUrl);
  if (!source.ok) throw new Error(`YouTube: could not read video (${source.status})`);
  const bytes = new Uint8Array(await source.arrayBuffer());

  const metadata = {
    snippet: {
      title: (title || "Untitled").slice(0, 100),
      description: (description || "").slice(0, 5000),
      tags: Array.isArray(tags) ? tags.slice(0, 30) : undefined,
    },
    status: {
      // With a publishAt, the video must be uploaded private: YouTube flips it to
      // public at that moment. Without one (the scheduler calls this once the
      // slot is due) it goes up public straight away. Either way, Google keeps
      // uploads from an API project that has not passed YouTube's compliance
      // audit private, whatever is asked for here.
      privacyStatus: publishAt ? "private" : "public",
      publishAt: publishAt || undefined,
      selfDeclaredMadeForKids: false,
    },
  };

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(bytes.byteLength),
        "x-upload-content-type": "video/*",
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`YouTube: upload init failed ${initRes.status} ${text.slice(0, 200)}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube: upload init returned no session URL");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/*", "content-length": String(bytes.byteLength) },
    body: bytes,
  });
  const putText = await putRes.text();
  if (!putRes.ok) throw new Error(`YouTube: upload failed ${putRes.status} ${putText.slice(0, 200)}`);

  const created = JSON.parse(putText);
  return {
    id: created.id,
    permalink: created.id ? `https://www.youtube.com/watch?v=${created.id}` : null,
  };
}

/** True when the granted Google token can upload, not just read. */
export async function youtubeCanUpload() {
  try {
    const accessToken = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return false;
    const info = await res.json();
    return String(info.scope || "").includes("youtube.upload");
  } catch {
    return false;
  }
}
