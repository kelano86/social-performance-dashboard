import type { Config, Context } from "@netlify/functions";
import { mediaStore } from "../lib/store.mjs";

// Public, unauthenticated by necessity: Instagram publishes a reel by fetching
// the video from a URL, and its fetcher sends no credentials. The id is 32 hex
// characters of randomness, and the file is one about to be posted publicly.
//
// Deliberately NOT behind DASH_KEY. Gating this would break publishing.
export default async (req: Request, context: Context) => {
  const id = context.params?.id;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    return new Response("not found", { status: 404 });
  }

  const store = mediaStore();
  const result = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!result?.data) return new Response("not found", { status: 404 });

  const contentType = (result.metadata?.contentType as string) || "video/mp4";
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(result.data.byteLength),
    // Immutable: a media id is never reused, so this can cache hard.
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "none",
  };

  if (req.method === "HEAD") return new Response(null, { headers });
  return new Response(result.data, { headers });
};

export const config: Config = {
  path: "/media/:id",
};
