import type { Context } from "@netlify/functions";
import { readSchedule, mutateSchedule } from "../lib/store.mjs";
import { publishInstagramReel, publishYouTubeVideo } from "../lib/publish.mjs";
import { env } from "../lib/env.mjs";

// A background function, because Instagram's transcode wait routinely outlasts
// the 30 second budget a normal function gets. Background functions have 15
// minutes and return 202 immediately, which is why the cron tick just pokes
// this and exits.

const MAX_ATTEMPTS = 3;

export default async (req: Request, _context: Context) => {
  // Not publicly triggerable: publishing to a live account is not something a
  // stray request should be able to start.
  const key = env("DASH_KEY");
  if (key && req.headers.get("x-dash-key") !== key) {
    console.warn("[publish] rejected an unauthenticated invocation");
    return;
  }

  const now = Date.now();
  const items = await readSchedule();
  const due = items.filter(
    (it) =>
      it.status === "scheduled" &&
      Date.parse(it.scheduledAt) <= now &&
      (it.attempts || 0) < MAX_ATTEMPTS
  );

  if (!due.length) {
    console.log("[publish] nothing due");
    return;
  }
  console.log(`[publish] ${due.length} item(s) due`);

  const origin = env("URL") || env("DEPLOY_PRIME_URL") || "";

  for (const item of due) {
    // Claim it first. If this run dies mid-publish, the item is left in
    // "publishing" rather than being picked up again by the next tick and
    // posted twice. Double-posting is worse than a stuck item a human can see.
    await mutateSchedule((all) =>
      all.map((it) =>
        it.id === item.id
          ? { ...it, status: "publishing", attempts: (it.attempts || 0) + 1, updatedAt: new Date().toISOString() }
          : it
      )
    );

    const videoUrl = `${origin}/media/${item.mediaId}`;
    const results = JSON.parse(JSON.stringify(item.results));

    if (item.targets?.instagram) {
      try {
        const r = await publishInstagramReel({ videoUrl, caption: item.caption });
        results.instagram = { status: "published", permalink: r.permalink, error: null, at: new Date().toISOString() };
        console.log(`[publish] ${item.id} instagram ok ${r.permalink || r.id}`);
      } catch (err) {
        results.instagram = {
          status: "failed",
          permalink: null,
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        };
        console.error(`[publish] ${item.id} instagram failed:`, results.instagram.error);
      }
    }

    if (item.targets?.youtube) {
      try {
        const r = await publishYouTubeVideo({
          videoUrl,
          title: item.title || item.caption?.slice(0, 90) || item.filename,
          description: item.caption,
          // Already past due, so publish on arrival rather than scheduling it
          // into the past, which YouTube rejects.
          publishAt: undefined,
        });
        results.youtube = { status: "published", permalink: r.permalink, error: null, at: new Date().toISOString() };
        console.log(`[publish] ${item.id} youtube ok ${r.permalink}`);
      } catch (err) {
        results.youtube = {
          status: "failed",
          permalink: null,
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        };
        console.error(`[publish] ${item.id} youtube failed:`, results.youtube.error);
      }
    }

    const wanted = ["instagram", "youtube"].filter((p) => item.targets?.[p]);
    const done = wanted.every((p) => results[p].status === "published");
    const anyFailed = wanted.some((p) => results[p].status === "failed");
    // A partial success stays "scheduled" only while retries remain, and the
    // retry re-runs just the platform that failed.
    const status = done
      ? "published"
      : anyFailed && (item.attempts || 0) + 1 >= MAX_ATTEMPTS
        ? "failed"
        : "scheduled";

    await mutateSchedule((all) =>
      all.map((it) =>
        it.id === item.id
          ? {
              ...it,
              results,
              status,
              targets: {
                // Do not re-post a platform that already succeeded.
                instagram: it.targets.instagram && results.instagram.status !== "published",
                youtube: it.targets.youtube && results.youtube.status !== "published",
              },
              updatedAt: new Date().toISOString(),
            }
          : it
      )
    );
  }
};
