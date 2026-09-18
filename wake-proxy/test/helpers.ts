/**
 * Shared test utilities: temp state directories, throwaway HTTP backends and
 * free ports.
 */
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import type { Duplex } from "stream";
import { clearLastAccessCache } from "../src/lastAccess";

/** A fresh temp directory. */
export function makeTempDir(prefix = "wake-proxy-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Point the state store (`WAKEUP_STATE_DIR`) at a fresh temp directory for
 * every test in the calling file. Returns a getter for the current directory.
 */
export function useTempStateDir(): () => string {
  let dir = "";
  const previous = process.env.WAKEUP_STATE_DIR;
  beforeEach(() => {
    dir = makeTempDir("wake-proxy-state-");
    process.env.WAKEUP_STATE_DIR = dir;
    clearLastAccessCache();
  });
  afterEach(() => {
    clearLastAccessCache();
    if (previous === undefined) delete process.env.WAKEUP_STATE_DIR;
    else process.env.WAKEUP_STATE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** Silence console output for the calling file and expose the spies. */
export function mockConsole(): Record<"log" | "info" | "warn" | "error", jest.SpyInstance> {
  const spies = {} as Record<"log" | "info" | "warn" | "error", jest.SpyInstance>;
  beforeEach(() => {
    spies.log = jest.spyOn(console, "log").mockImplementation(() => {});
    spies.info = jest.spyOn(console, "info").mockImplementation(() => {});
    spies.warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    spies.error = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  return spies;
}

/** A port nothing is listening on right now. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockBackend {
  server: http.Server;
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** `127.0.0.1:<port>` */
  hostPort: string;
  requests: RecordedRequest[];
  /** Number of WebSocket upgrades that were accepted */
  upgrades: number;
  close(): Promise<void>;
}

export type BackendHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * A throwaway HTTP backend on 127.0.0.1. By default it answers 200 with a
 * JSON echo of the request and accepts WebSocket upgrades as an echo socket.
 */
export function startMockBackend(handler?: BackendHandler, port = 0): Promise<MockBackend> {
  const requests: RecordedRequest[] = [];
  const upgraded = new Set<Duplex>();
  const backend = { requests, upgrades: 0 } as MockBackend;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (handler) return handler(req, res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  server.on("upgrade", (req, socket) => {
    backend.upgrades++;
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    upgraded.add(socket);
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => socket.end());
    socket.on("close", () => upgraded.delete(socket));
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      Object.assign(backend, {
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        hostPort: `127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            // Upgraded sockets are not tracked by closeAllConnections()
            for (const sock of upgraded) sock.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
      resolve(backend);
    });
  });
}

/** Resolves after `ms` without fake timers interfering. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` is true or `timeoutMs` passes. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await realSleep(20);
  }
}
