// Minimal static server with HTTP Range (206) for browser video seeking.
// Usage: node static-server-range.mjs <root> [port]
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8090);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ttc": "font/ttc",
};

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = normalize(join(ROOT, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(normalize(ROOT))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const st = await stat(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { "Content-Range": "bytes */" + st.size }).end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Range": "bytes " + start + "-" + end + "/" + st.size,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Cache-Control": "no-store",
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log("static server on http://127.0.0.1:" + PORT));
