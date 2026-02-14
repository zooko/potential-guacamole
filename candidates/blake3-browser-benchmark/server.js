"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3000;

// MIME types for static files
const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "text/typescript",
};

// Serve from repo root (potential-guacamole/)
const REPO_ROOT = path.resolve(__dirname, "../..");

const server = http.createServer((req, res) => {
  // Required headers for SharedArrayBuffer support
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  // Handle root redirect
  let urlPath = req.url.split("?")[0]; // Remove query string
  if (urlPath === "/") {
    urlPath = "/candidates/blake3-browser-benchmark/index.html";
  }

  const filePath = path.join(REPO_ROOT, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Security: prevent directory traversal
  if (!filePath.startsWith(REPO_ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`404 Not Found: ${urlPath}`);
        console.log(`404: ${urlPath}`);
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`500 Server Error: ${err.message}`);
        console.error(`500: ${urlPath} - ${err.message}`);
      }
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
    console.log(`200: ${urlPath}`);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║  BLAKE3 Browser Benchmark Server                                      ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                            ║
║  Serving files from: ${REPO_ROOT}
║                                                                       ║
║  SharedArrayBuffer headers enabled:                                   ║
║    Cross-Origin-Opener-Policy: same-origin                            ║
║    Cross-Origin-Embedder-Policy: require-corp                         ║
║                                                                       ║
║  Open http://localhost:${PORT} in Chrome to run benchmark               ║
║  Or: http://localhost:${PORT}/candidates/blake3-browser-benchmark/      ║
║                                                                       ║
║  Press Ctrl+C to stop                                                 ║
╚═══════════════════════════════════════════════════════════════════════╝
`);
});
