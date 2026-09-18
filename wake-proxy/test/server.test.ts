import fs from "fs";
import net from "net";
import request from "supertest";
import * as idleShutdown from "../src/idleShutdown";
import * as tcpProxy from "../src/tcpProxy";
import * as updateChecker from "../src/updateChecker";
import { assertShellAvailable, listenAddress, startServer, type RunningProxy } from "../src/server";
import { getFreePort, mockConsole, useTempStateDir, waitUntil } from "./helpers";

const console = mockConsole();
useTempStateDir();

let running: RunningProxy | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("assertShellAvailable", () => {
  it("passes on a normal system and throws without /bin/sh", () => {
    expect(() => assertShellAvailable()).not.toThrow();
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() => assertShellAvailable()).toThrow("/bin/sh does not exist or is not accessible");
  });
});

describe("listenAddress", () => {
  it("applies the documented defaults", () => {
    expect(listenAddress({ services: [] })).toEqual({ port: 8080, host: "0.0.0.0" });
    expect(listenAddress({ proxyPort: 0, bindHost: "", services: [] })).toEqual({
      port: 8080,
      host: "0.0.0.0",
    });
    expect(listenAddress({ proxyPort: 9090, bindHost: "127.0.0.1", services: [] })).toEqual({
      port: 9090,
      host: "127.0.0.1",
    });
  });
});

describe("startServer", () => {
  it("listens on the configured address, starts tcp proxies and the background checkers", async () => {
    const startIdle = jest.spyOn(idleShutdown, "startIdleShutdownChecker");
    const startUpdate = jest
      .spyOn(updateChecker, "startUpdateChecker")
      .mockReturnValue(setInterval(() => {}, 1e9));
    const startTcp = jest.spyOn(tcpProxy, "startTcpProxy");
    const proxyPort = await getFreePort();
    const listenPort = await getFreePort();
    const config = {
      proxyPort,
      bindHost: "127.0.0.1",
      idleThreshold: 3600,
      services: [
        { route: "app", target: "http://127.0.0.1:1", composeDir: "/x" },
        { route: "mc", target: "127.0.0.1:1", type: "tcp" as const, listenPort, composeDir: "/x" },
        { route: "bad route", target: "http://127.0.0.1:1" },
      ],
    };

    running = startServer(config);
    await waitUntil(() => running!.server.listening);
    expect(console.log).toHaveBeenCalledWith(`Wake proxy listening on 127.0.0.1:${proxyPort}`);
    expect(Object.keys(running.services)).toEqual(["app", "mc"]);

    const res = await request(running.server).get("/healthz");
    expect(res.body).toMatchObject({ ok: true, services: 2 });

    expect(startTcp).toHaveBeenCalledTimes(1);
    expect(running.tcpProxies).toHaveLength(1);
    await waitUntil(() => running!.tcpProxies[0].server.listening);
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(listenPort, "127.0.0.1", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", reject);
    });

    expect(startIdle).toHaveBeenCalledWith(running.services, 3600);
    expect(startUpdate).toHaveBeenCalledTimes(1);
  });

  it("binds all interfaces by default and skips the update check when disabled", async () => {
    const startUpdate = jest.spyOn(updateChecker, "startUpdateChecker");
    const proxyPort = await getFreePort();
    running = startServer({ proxyPort, updateCheck: false, services: [] });
    await waitUntil(() => running!.server.listening);
    expect(console.log).toHaveBeenCalledWith(`Wake proxy listening on 0.0.0.0:${proxyPort}`);
    expect(startUpdate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "Idle shutdown disabled (no idleThreshold in config.json)",
    );
  });

  it("close() stops listening and rejects when the server was not running", async () => {
    const proxyPort = await getFreePort();
    const proxy = startServer({
      proxyPort,
      bindHost: "127.0.0.1",
      updateCheck: false,
      services: [],
    });
    await waitUntil(() => proxy.server.listening);
    await proxy.close();
    expect(proxy.server.listening).toBe(false);
    await expect(proxy.close()).rejects.toThrow(/not running/);
  });
});
