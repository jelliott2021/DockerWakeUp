import { EventEmitter } from "events";
import type { Request, Response } from "express";
import * as wakeManager from "../src/wakeManager";
import { SSE_PING_INTERVAL_MS, sendWakeStatus, streamWakeLogs } from "../src/wakeEndpoints";

jest.mock("../src/wakeManager", () => ({
  getWakeStatus: jest.fn(),
  getExpectedWakeMs: jest.fn(),
  isServiceReady: jest.fn(),
  streamServiceLogs: jest.fn(),
}));
const getWakeStatus = wakeManager.getWakeStatus as jest.MockedFunction<
  typeof wakeManager.getWakeStatus
>;
const getExpectedWakeMs = wakeManager.getExpectedWakeMs as jest.MockedFunction<
  typeof wakeManager.getExpectedWakeMs
>;
const isServiceReady = wakeManager.isServiceReady as jest.MockedFunction<
  typeof wakeManager.isServiceReady
>;
const streamServiceLogs = wakeManager.streamServiceLogs as jest.MockedFunction<
  typeof wakeManager.streamServiceLogs
>;

const svc = { route: "app", target: "http://127.0.0.1:1", composeDir: "/x" };

beforeEach(() => {
  getWakeStatus.mockReturnValue({ state: "idle" });
  getExpectedWakeMs.mockReturnValue(null);
  isServiceReady.mockResolvedValue(false);
  streamServiceLogs.mockReturnValue(() => {});
});
afterEach(() => jest.useRealTimers());

describe("sendWakeStatus", () => {
  const makeRes = () => ({ json: jest.fn() }) as unknown as Response & { json: jest.Mock };

  it("reports an idle service", async () => {
    const res = makeRes();
    await sendWakeStatus(svc, res);
    expect(res.json).toHaveBeenCalledWith({
      state: "idle",
      ready: false,
      startedAt: undefined,
      error: undefined,
      expectedMs: null,
      elapsedMs: null,
    });
  });

  it("reports progress while starting", async () => {
    jest.useFakeTimers({ now: 10_000 });
    getWakeStatus.mockReturnValue({ state: "starting", startedAt: 4_000 });
    getExpectedWakeMs.mockReturnValue(9_000);
    const res = makeRes();
    await sendWakeStatus(svc, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "starting",
        startedAt: 4_000,
        expectedMs: 9_000,
        elapsedMs: 6_000,
      }),
    );
  });

  it("reports readiness and errors", async () => {
    getWakeStatus.mockReturnValue({ state: "failed", startedAt: 1, error: "boom" });
    isServiceReady.mockResolvedValue(true);
    const res = makeRes();
    await sendWakeStatus(svc, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", ready: true, error: "boom", elapsedMs: null }),
    );
    expect(isServiceReady).toHaveBeenCalledWith(svc);
  });
});

describe("streamWakeLogs", () => {
  function makeStream() {
    const req = new EventEmitter() as unknown as Request;
    const writes: string[] = [];
    const res = {
      writeHead: jest.fn(),
      write: jest.fn((chunk: string) => writes.push(chunk)),
    } as unknown as Response & { writeHead: jest.Mock };
    return { req, res, writes };
  }
  const event = (line: string) => `data: ${JSON.stringify(line)}\n\n`;

  it("opens an SSE stream and explains when log streaming is disabled", () => {
    const { req, res, writes } = makeStream();
    streamWakeLogs(svc, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(writes).toEqual([
      "retry: 3000\n\n",
      event(
        '[wake-proxy] log streaming is disabled for this service (set "showLogs": true in config.json to enable)',
      ),
    ]);
    expect(streamServiceLogs).not.toHaveBeenCalled();
    req.emit("close"); // nothing to stop, nothing breaks
  });

  it("only streams while a wake is in progress or just failed", () => {
    const opted = { ...svc, showLogs: true };
    const { req, res, writes } = makeStream();
    streamWakeLogs(opted, req, res);
    expect(writes[1]).toBe(
      event("[wake-proxy] log streaming is only available while the service is starting"),
    );
    expect(streamServiceLogs).not.toHaveBeenCalled();
    req.emit("close");

    for (const state of ["starting", "failed"] as const) {
      getWakeStatus.mockReturnValue({ state, startedAt: 1 });
      const stream = makeStream();
      streamWakeLogs(opted, stream.req, stream.res);
      stream.req.emit("close"); // stops the ping timer
    }
    expect(streamServiceLogs).toHaveBeenCalledTimes(2);
  });

  it("forwards log lines as events and stops everything when the client leaves", () => {
    jest.useFakeTimers();
    const stop = jest.fn();
    let onLine: (line: string) => void = () => {};
    streamServiceLogs.mockImplementation((_svc, cb) => {
      onLine = cb;
      return stop;
    });
    getWakeStatus.mockReturnValue({ state: "starting", startedAt: 1 });
    const { req, res, writes } = makeStream();
    streamWakeLogs({ ...svc, showLogs: true }, req, res);

    onLine("hello");
    jest.advanceTimersByTime(SSE_PING_INTERVAL_MS);
    expect(writes).toEqual(["retry: 3000\n\n", event("hello"), ": ping\n\n"]);

    req.emit("close");
    expect(stop).toHaveBeenCalled();
    jest.advanceTimersByTime(SSE_PING_INTERVAL_MS * 2);
    expect(writes).toHaveLength(3);
  });
});
