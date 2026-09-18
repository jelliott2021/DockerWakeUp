import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import type { Request, Response } from "express";
import type net from "net";
import * as wakeManager from "../src/wakeManager";
import {
  RETRY_WAIT_MS,
  countsAsActivity,
  handleProxyError,
  type ProxyMiddleware,
} from "../src/proxy";
import { renderDefaultWakePage } from "../src/wakePage";
import { makeTempDir, mockConsole } from "./helpers";

jest.mock("../src/wakeManager", () => ({
  triggerWake: jest.fn(() => Promise.resolve()),
  waitForReady: jest.fn(),
}));
const triggerWake = wakeManager.triggerWake as jest.MockedFunction<typeof wakeManager.triggerWake>;
const waitForReady = wakeManager.waitForReady as jest.MockedFunction<
  typeof wakeManager.waitForReady
>;

const console = mockConsole();

const svc = { route: "app", target: "http://127.0.0.1:1", composeDir: "/x" };
const config = { services: [svc] };

function makeReq(method?: string, accept?: string): Request {
  return { method, headers: accept === undefined ? {} : { accept } } as unknown as Request;
}

function makeRes(headersSent = false) {
  const res = { headersSent, writeHead: jest.fn(), end: jest.fn() };
  return res as unknown as Response & typeof res;
}

const retryProxy = jest.fn() as unknown as jest.MockedFunction<ProxyMiddleware>;

describe("countsAsActivity", () => {
  it("is true for 2xx and 3xx responses only", () => {
    expect(countsAsActivity(200)).toBe(true);
    expect(countsAsActivity(304)).toBe(true);
    expect(countsAsActivity(399)).toBe(true);
    expect(countsAsActivity(199)).toBe(false);
    expect(countsAsActivity(404)).toBe(false);
    expect(countsAsActivity(502)).toBe(false);
    expect(countsAsActivity(undefined)).toBe(false);
  });
});

describe("handleProxyError", () => {
  it("always kicks off a wake and logs it", async () => {
    await handleProxyError("app", svc, config, makeReq("POST"), makeRes(), retryProxy);
    expect(console.warn).toHaveBeenCalledWith("Proxy to app failed, waking service...");
    expect(triggerWake).toHaveBeenCalledWith("app", svc);
  });

  it("closes the raw socket of a failed WebSocket upgrade", async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: jest.fn() });
    await handleProxyError(
      "app",
      svc,
      config,
      makeReq("GET"),
      socket as unknown as net.Socket,
      retryProxy,
    );
    expect(socket.destroy).toHaveBeenCalled();
    socket.emit("error", new Error("ignored")); // the error listener swallows it
    expect(retryProxy).not.toHaveBeenCalled();
  });

  it("answers browser navigations with the wake page", async () => {
    const res = makeRes();
    await handleProxyError("app", svc, config, makeReq("GET", "text/html,*/*"), res, retryProxy);
    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    });
    expect(res.end).toHaveBeenCalledWith(renderDefaultWakePage("app"));
    expect(retryProxy).not.toHaveBeenCalled();
  });

  it("uses the per-service page, then the global one, for the wake page", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "global.html"), "global {{route}}");
    fs.writeFileSync(path.join(dir, "mine.html"), "mine {{route}}");
    const globalConfig = { ...config, wakePage: path.join(dir, "global.html") };

    const res = makeRes();
    await handleProxyError("app", svc, globalConfig, makeReq("GET", "text/html"), res, retryProxy);
    expect(res.end).toHaveBeenCalledWith("global app");

    const own = makeRes();
    const customSvc = { ...svc, wakePage: path.join(dir, "mine.html") };
    await handleProxyError(
      "app",
      customSvc,
      globalConfig,
      makeReq("GET", "text/html"),
      own,
      retryProxy,
    );
    expect(own.end).toHaveBeenCalledWith("mine app");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not write the wake page when headers were already sent", async () => {
    const res = makeRes(true);
    await handleProxyError("app", svc, config, makeReq("GET", "text/html"), res, retryProxy);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects non-idempotent requests immediately with Retry-After", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", undefined]) {
      const res = makeRes();
      await handleProxyError("app", svc, config, makeReq(method), res, retryProxy);
      expect(res.writeHead).toHaveBeenCalledWith(503, {
        "Content-Type": "application/json",
        "Retry-After": "15",
      });
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({ error: "app is starting up. Retry shortly." }),
      );
    }
    expect(retryProxy).not.toHaveBeenCalled();
    expect(waitForReady).not.toHaveBeenCalled();

    const sent = makeRes(true);
    await handleProxyError("app", svc, config, makeReq("POST"), sent, retryProxy);
    expect(sent.writeHead).not.toHaveBeenCalled();
  });

  it("waits for the service and replays safe requests", async () => {
    waitForReady.mockResolvedValue(undefined);
    for (const method of ["GET", "head"]) {
      const req = makeReq(method, "application/json");
      const res = makeRes();
      await handleProxyError("app", svc, config, req, res, retryProxy);
      expect(waitForReady).toHaveBeenCalledWith(svc, RETRY_WAIT_MS);
      expect(retryProxy).toHaveBeenCalledWith(req, res, expect.any(Function));
      expect(res.writeHead).not.toHaveBeenCalled();
    }
    const next = retryProxy.mock.calls[0][2] as () => void;
    expect(next()).toBeUndefined();
  });

  it("answers 503 when the service does not come up for a safe request", async () => {
    waitForReady.mockRejectedValue(new Error("Timeout"));
    const res = makeRes();
    await handleProxyError("app", svc, config, makeReq("GET"), res, retryProxy);
    expect(console.error).toHaveBeenCalledWith("Failed to recover service app:", expect.any(Error));
    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "application/json",
      "Retry-After": "5",
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: "app is starting up. Try again shortly." }),
    );

    const sent = makeRes(true);
    await handleProxyError("app", svc, config, makeReq("GET"), sent, retryProxy);
    expect(sent.writeHead).not.toHaveBeenCalled();
  });
});
