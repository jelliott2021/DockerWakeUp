#!/usr/bin/env node
/**
 * Throwaway HTTP service for the API and end-to-end tests. Started in-process
 * by the harness for the "already running" service, and as a child process
 * (via a service's `startCommand`) for the services that get woken.
 *
 *   node mock-backend.js <port> [name]
 *
 * GET /            → a small HTML page (what a browser lands on after the wake page reloads)
 * anything else    → JSON echo of the request (method, url, headers)
 */
const http = require("http");

const port = Number(process.argv[2]);
const name = process.argv[3] || "mock";
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: mock-backend.js <port> [name]");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (
      req.method === "GET" &&
      req.url === "/" &&
      String(req.headers.accept).includes("text/html")
    ) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><head><title>${name} is up</title></head><body><h1 id="app">${name} service is running</h1></body></html>`,
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, method: req.method, url: req.url, headers: req.headers, body }));
  });
});

server.on("upgrade", (req, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  socket.on("data", (data) => socket.write(data));
  socket.on("end", () => socket.end());
  socket.on("error", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(`${name} listening on 127.0.0.1:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
