// Minimal static server for local UI verification, with no credentials and no
// network: serves public/ and answers /api/data from .local/sample.json,
// /api/snapshots from .local/snapshots.json and /api/details from
// .local/details.json (all written by make-fixture.mjs from synthetic data).
// /api/schedule returns an empty queue; uploading and scheduling only work on
// a Netlify deploy.
//   node scripts/make-fixture.mjs
//   node scripts/dev-server.mjs [port]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { readSeries, readDay } from "../netlify/lib/snapshots.mjs";
import { detailsFor } from "../netlify/lib/details.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
const samplePath = resolve(here, "../.local/sample.json");
const snapshotsPath = resolve(here, "../.local/snapshots.json");
const detailsPath = resolve(here, "../.local/details.json");
const port = Number(process.argv[2] || 5310);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/data") {
    try {
      const body = await readFile(samplePath, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no fixture: run node scripts/make-fixture.mjs" }));
    }
    return;
  }

  if (url.pathname === "/api/snapshots") {
    try {
      const { asOf, blobs } = JSON.parse(await readFile(snapshotsPath, "utf8"));
      const fileStore = { get: async (key) => (key in blobs ? structuredClone(blobs[key]) : null) };
      const day = url.searchParams.get("day");
      const body = day
        ? await readDay(fileStore, day, undefined, Date.parse(asOf))
        : await readSeries(fileStore, url.searchParams.get("platform"), url.searchParams.get("id"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no snapshot fixture: run node scripts/make-fixture.mjs (" + err.message + ")" }));
    }
    return;
  }

  if (url.pathname === "/api/details") {
    let blob = null;
    try {
      blob = JSON.parse(await readFile(detailsPath, "utf8"));
    } catch {
      /* no fixture: every post reads as not fetched yet */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(detailsFor(blob, url.searchParams.get("platform"), url.searchParams.get("id"))));
    return;
  }

  if (url.pathname === "/api/schedule" || url.pathname === "/api/upload") {
    const read = req.method === "GET" && url.pathname === "/api/schedule";
    res.writeHead(read ? 200 : 501, { "content-type": "application/json" });
    res.end(JSON.stringify(read ? { items: [] } : { error: "not available in the local dev server: deploy to Netlify to schedule posts" }));
    return;
  }

  if (url.pathname === "/api/refresh") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), durationMs: 0, items: 0, warnings: [] }));
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(publicDir, "." + normalize(rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log("dev server on http://localhost:" + port);
});
