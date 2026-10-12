// Collects each platform's raw rows straight from its official API:
// YouTube Data + Analytics (google.mjs) and the Instagram Graph API (meta.mjs).
//
// A platform whose credentials are not set is skipped with a warning, so the
// dashboard can run on YouTube alone or Instagram alone while the other is
// still being set up. With neither configured the refresh fails: there would be
// nothing to show, and the previously cached dataset stays served.

import { env } from "./env.mjs";
import { fetchYouTube, googleConfigured } from "./google.mjs";
import { fetchInstagram, metaConfigured, inspectToken } from "./meta.mjs";

const GOOGLE_VARS = "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN";

/**
 * `opts.igDaily` is the pending read of the Instagram daily cache (see
 * igdaily.mjs); the Instagram pull uses it to skip days already stored.
 *
 * `sources.youtube` / `sources.instagram` are "direct" when that platform was
 * pulled and "off" when its credentials are not set. The footer shows them.
 */
export async function collect(opts = {}) {
  const warnings = [];
  const sources = {};
  const raw = {};

  const hasYouTube = googleConfigured();
  const hasInstagram = metaConfigured();
  if (!hasYouTube && !hasInstagram) {
    throw new Error(
      `No platform is configured. Set ${GOOGLE_VARS} for YouTube, and/or META_ACCESS_TOKEN ` +
        "(plus META_APP_ID and META_APP_SECRET) for Instagram, then redeploy."
    );
  }

  const skipped = (message) => Promise.resolve({ raw: {}, warnings: [message] });

  // ---------- YouTube ----------
  let youtube;
  if (hasYouTube) {
    youtube = fetchYouTube().then((res) => {
      sources.youtube = "direct";
      return res;
    });
  } else {
    sources.youtube = "off";
    youtube = skipped(`YouTube skipped: ${GOOGLE_VARS} are not all set`);
  }

  // ---------- Instagram ----------
  let instagram;
  if (hasInstagram) {
    instagram = fetchInstagram(undefined, { igDaily: opts.igDaily }).then((res) => {
      sources.instagram = "direct";
      sources.instagramAuth = res.authMode;
      return res;
    });
  } else {
    sources.instagram = "off";
    instagram = skipped("Instagram skipped: META_ACCESS_TOKEN is not set");
  }

  const [yt, ig] = await Promise.all([youtube, instagram]);
  Object.assign(raw, yt.raw, ig.raw);
  warnings.push(...yt.warnings, ...ig.warnings);

  // Surface a Meta token nearing its 60 day expiry while there is still time to
  // act. A silently dead token is the main operational risk of this setup.
  let tokenStatus = null;
  if (sources.instagram === "direct") {
    tokenStatus = await inspectToken(env("META_ACCESS_TOKEN"));
    if (tokenStatus && tokenStatus.daysLeft !== null && tokenStatus.daysLeft <= 14) {
      warnings.push(
        `Meta access token expires in ${tokenStatus.daysLeft} day(s). Refresh it before it lapses; ` +
          "once expired it cannot be refreshed and needs a fresh authorisation."
      );
    }
  }

  return { raw, warnings, sources, tokenStatus };
}
