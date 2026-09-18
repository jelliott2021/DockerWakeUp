/**
 * In-process integration tests: the real Express app in front of throwaway
 * HTTP backends, driven with supertest and raw sockets (WebSocket upgrades).
 */
import fs from "fs";
import http from "http";
import type net from "net";
import path from "path";
import type { Request } from "express";
import type { Duplex } from "stream";
import request from "supertest";
import * as wakeManager from "../src/wakeManager";
import { createApp, isLocalRequest, type WakeProxyApp } from "../src/app";
import { indexServices, type Config } from "../src/config";
import { getLastAccess } from "../src/lastAccess";
import { getUpdateInfo } from "../src/updateChecker";
import {
  getFreePort,
  makeTempDir,
  mockConsole,
  startMockBackend,
  useTempStateDir,
  type MockBackend,
} from "./helpers";

jest.mock("../src/wakeManager", () => ({
  ...jest.requireActual("../src/wakeManager"),
  triggerWake: jest.fn(() => Promise.resolve()),
  waitForReady: jest.fn(),
  getWakeStatus: jest.fn(() => ({ state: "idle" })),
}));
const triggerWake = wakeManager.triggerWake as jest.MockedFunction<typeof wakeManager.triggerWake>;
const waitForReady = wakeManager.waitForReady as jest.MockedFunction<
  typeof wakeManager.waitForReady
>;
const getWakeStatus = wakeManager.getWakeStatus as jest.MockedFunction<
  typeof wakeManager.getWakeStatus
>;

mockConsole();
useTempStateDir();

let up: MockBackend;
let broken: MockBackend;
let downPort: number;
let wakePageDir: string;
let config: Config;
let wakeApp: WakeProxyApp;
let server: http.Server;
let port: number;
const upgradedSockets = new Set<Duplex>();

beforeAll(async () => {
  up = await startMockBackend();
  broken = await startMockBackend((_req, res) => {
    res.writeHead(500);
    res.end("nope");
  });
  downPort = await getFreePort();
  wakePageDir = makeTempDir("pages-");
  fs.writeFileSync(path.join(wakePageDir, "custom.html"), "<p>custom page for {{route}}</p>");

  config = {
    domain: "example.com",
    services: [
      { route: "up", target: up.url, composeDir: "/x", showLogs: true, logsCommand: "echo hello" },
      { route: "broken", target: broken.url, composeDir: "/x" },
      {
        route: "down",
        target: `http://127.0.0.1:${downPort}`,
        composeDir: "/x",
        domains: ["alias.example.org"],
      },
      {
        route: "custom",
        target: `http://127.0.0.1:${downPort}`,
        composeDir: "/x",
        wakePage: path.join(wakePageDir, "custom.html"),
      },
      { route: "mc", target: "127.0.0.1:1", type: "tcp", listenPort: 1 },
    ],
  };
  wakeApp = createApp(config, indexServices(config.services));
  server = http.createServer(wakeApp.app);
  server.on("upgrade", (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.on("close", () => upgradedSockets.delete(socket));
    wakeApp.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const sock of upgradedSockets) sock.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await up.close();
  await broken.close();
  fs.rmSync(wakePageDir, { recursive: true, force: true });
});

beforeEach(() => {
  getWakeStatus.mockReturnValue({ state: "idle" });
});

const api = () => request(server);

describe("createApp", () => {
  it("creates one proxy per HTTP service and none for tcp services", () => {
    expect(Object.keys(wakeApp.proxies).sort()).toEqual(["broken", "custom", "down", "up"]);
    expect(wakeApp.router.hosts["up.example.com"]).toBe("up");
  });
});

describe("GET /healthz", () => {
  it("answers direct local checks with full detail", async () => {
    const res = await api().get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, services: 5, update: getUpdateInfo() });
  });

  it("hides the detail from forwarded requests", async () => {
    const res = await api().get("/healthz").set("X-Forwarded-For", "203.0.113.5");
    expect(res.body).toEqual({ ok: true });
  });

  it("is proxied to the service when the hostname belongs to one", async () => {
    const res = await api().get("/healthz").set("Host", "up.example.com");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("/healthz");
  });
});

describe("isLocalRequest", () => {
  const req = (remoteAddress: string | undefined, headers = {}) =>
    ({ socket: { remoteAddress }, headers }) as unknown as Request;

  it("accepts loopback addresses without forwarding headers", () => {
    expect(isLocalRequest(req("127.0.0.1"))).toBe(true);
    expect(isLocalRequest(req("::1"))).toBe(true);
    expect(isLocalRequest(req("::ffff:127.0.0.1"))).toBe(true);
    expect(isLocalRequest(req("10.0.0.5"))).toBe(false);
    expect(isLocalRequest(req(undefined))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }))).toBe(false);
  });
});

describe("wake status endpoint", () => {
  it("serves the path-prefixed form", async () => {
    const res = await api().get("/proxy/up/__wake/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "idle", ready: true, expectedMs: null, elapsedMs: null });
    expect((await api().get("/proxy/nope/__wake/status")).status).toBe(404);
    expect((await api().get("/proxy/nope/__wake/status")).body).toEqual({
      error: "unknown service",
    });
  });

  it("serves the host-resolved form, including aliases", async () => {
    const res = await api().get("/__wake/status").set("Host", "alias.example.org");
    expect(res.body).toEqual({ state: "idle", ready: false, expectedMs: null, elapsedMs: null });
    expect((await api().get("/__wake/status").set("Host", "other.example.com")).status).toBe(404);
  });
});

/** Read an SSE stream until `until` returns true, then hang up. */
function readSse(
  path: string,
  host: string,
  until: (text: string) => boolean,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
        if (until(text)) {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        }
      });
    });
    req.on("error", reject);
  });
}

describe("wake logs endpoint", () => {
  it("is an SSE stream that explains when streaming is disabled", async () => {
    const res = await readSse("/proxy/down/__wake/logs", "127.0.0.1", (t) =>
      t.includes("disabled"),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.text).toContain("retry: 3000");
    expect(res.text).toContain('"[wake-proxy] log streaming is disabled');
    expect((await api().get("/proxy/nope/__wake/logs")).status).toBe(404);
  });

  it("streams the service's logs while it is starting (host form)", async () => {
    getWakeStatus.mockReturnValue({ state: "starting", startedAt: Date.now() });
    const res = await readSse("/__wake/logs", "up.example.com", (t) => t.includes("hello"));
    expect(res.text).toContain('data: "hello"');
    expect((await api().get("/__wake/logs").set("Host", "other.example.com")).status).toBe(404);
  });
});

describe("proxying to a running service", () => {
  it("routes by hostname and passes the path through unchanged", async () => {
    const res = await api().get("/api/items?x=1").set("Host", "up.example.com");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("/api/items?x=1");
    expect(res.body.headers.host).toBe(up.hostPort);
  });

  it("routes by the /proxy/<route> prefix and strips it", async () => {
    const res = await api().get("/proxy/up/api/items?x=1");
    expect(res.body.url).toBe("/api/items?x=1");
    expect((await api().get("/proxy/up")).body.url).toBe("/");
  });

  it("forwards the original host and scheme to the service", async () => {
    const res = await api()
      .get("/")
      .set("Host", "up.example.com")
      .set("X-Forwarded-Host", "up.example.com")
      .set("X-Forwarded-Proto", "https");
    expect(res.body.headers.host).toBe("up.example.com");
    expect(res.body.headers["x-forwarded-host"]).toBe("up.example.com");
    expect(res.body.headers["x-forwarded-proto"]).toBe("https");
  });

  it("counts successful responses as activity, but not server errors", async () => {
    expect(getLastAccess("up")).toBeNull();
    await api().get("/").set("Host", "up.example.com");
    expect(getLastAccess("up")).not.toBeNull();
    const res = await api().get("/").set("Host", "broken.example.com");
    expect(res.status).toBe(500);
    expect(getLastAccess("broken")).toBeNull();
  });

  it("returns 404 for hostnames and paths that match nothing", async () => {
    expect((await api().get("/").set("Host", "nothing.example.com")).status).toBe(404);
    expect((await api().get("/proxy/nope/x")).status).toBe(404);
    expect((await api().get("/").set("Host", "mc.example.com")).status).toBe(404);
  });
});

describe("proxying to a sleeping service", () => {
  it("shows the wake page to browsers and triggers a wake", async () => {
    const res = await api().get("/").set("Host", "down.example.com").set("Accept", "text/html");
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.text).toContain("<title>Starting down…</title>");
    expect(triggerWake).toHaveBeenCalledWith("down", expect.objectContaining({ route: "down" }));
  });

  it("serves a custom wake page when configured", async () => {
    const res = await api().get("/proxy/custom/").set("Accept", "text/html");
    expect(res.status).toBe(503);
    expect(res.text).toBe("<p>custom page for custom</p>");
  });

  it("rejects non-idempotent requests right away", async () => {
    const res = await api().post("/api").set("Host", "down.example.com").send({ a: 1 });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("15");
    expect(res.body).toEqual({ error: "down is starting up. Retry shortly." });
  });

  it("waits for the service and replays safe requests", async () => {
    let woken: MockBackend | undefined;
    waitForReady.mockImplementationOnce(async () => {
      woken = await startMockBackend(undefined, downPort);
    });
    const res = await api()
      .get("/api/data")
      .set("Host", "down.example.com")
      .set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("/api/data");
    expect(woken!.requests).toHaveLength(1);
    await woken!.close();
  });

  it("answers 503 when the service does not come up in time", async () => {
    waitForReady.mockRejectedValueOnce(new Error("Timeout"));
    const res = await api().get("/api/data").set("Host", "down.example.com");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "down is starting up. Try again shortly." });
  });
});

/** Perform a WebSocket-style upgrade handshake against the proxy. */
function upgrade(
  path: string,
  host: string,
): Promise<{ status: number; socket: net.Socket | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "X-Forwarded-Proto": "https",
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, socket: null }));
    req.on("error", reject);
    req.end();
  });
}

describe("WebSocket upgrades", () => {
  it("hands host-routed upgrades to the service and pipes bytes", async () => {
    const { status, socket } = await upgrade("/socket", "up.example.com");
    expect(status).toBe(101);
    const echoed = await new Promise<string>((resolve) => {
      socket!.once("data", (d) => resolve(d.toString()));
      socket!.write("ping");
    });
    expect(echoed).toBe("ping");
    socket!.resetAndDestroy(); // a hard reset is an error on the proxy's side, which it ignores
    const handshake = up.requests[up.requests.length - 1];
    expect(handshake.url).toBe("/socket");
    expect(handshake.headers["x-forwarded-proto"]).toBe("https");
    expect(getLastAccess("up")).not.toBeNull();
  });

  it("strips the /proxy/<route> prefix from upgrades", async () => {
    const { status, socket } = await upgrade("/proxy/up/live?x=1", "127.0.0.1");
    expect(status).toBe(101);
    socket!.destroy();
    expect(up.requests[up.requests.length - 1].url).toBe("/live?x=1");
  });

  it("closes upgrades that match no service", async () => {
    await expect(upgrade("/socket", "nothing.example.com")).rejects.toThrow(/socket hang up/);
  });

  it("wakes a sleeping service and closes the socket for the client to retry", async () => {
    await expect(upgrade("/socket", "down.example.com")).rejects.toThrow(/socket hang up/);
    expect(triggerWake).toHaveBeenCalledWith("down", expect.objectContaining({ route: "down" }));
  });
});
