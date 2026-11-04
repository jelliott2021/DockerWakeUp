import fs from "fs";
import type http from "http";
import net from "net";
import request from "supertest";
import * as idleShutdown from "../src/idleShutdown";
import * as tcpProxy from "../src/tcpProxy";
import * as updateChecker from "../src/updateChecker";
import { assertShellAvailable, listenAddress, startServer, type RunningProxy } from "../src/server";
import { getFreePort, makeTempDir, mockConsole, useTempStateDir, waitUntil } from "./helpers";

const console = mockConsole();
useTempStateDir();

function listensOnPort(server: http.Server, port: number): boolean {
  const address = server.address();
  return address !== null && typeof address !== "string" && address.port === port;
}

let running: RunningProxy | undefined;
let configDir: string | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
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

  it("reloads service and domain changes, retaining the current config on invalid JSON", async () => {
    configDir = makeTempDir("wake-proxy-config-");
    const configPath = `${configDir}/config.json`;
    const proxyPort = await getFreePort();
    const initialConfig = {
      proxyPort,
      bindHost: "127.0.0.1",
      updateCheck: false,
      domain: "old.example.test",
      services: [{ route: "old", target: "http://127.0.0.1:1" }],
    };
    fs.writeFileSync(configPath, JSON.stringify(initialConfig));
    running = startServer(initialConfig, configPath);
    await waitUntil(() => running!.server.listening);
    expect((await request(running.server).get("/proxy/old/__wake/status")).status).toBe(200);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...initialConfig,
        domain: "new.example.test",
        services: [
          { route: "fresh", target: "http://127.0.0.1:1", domains: ["alias.example.test"] },
        ],
      }),
    );
    await waitUntil(() => "fresh" in running!.services);
    expect(running.services).toHaveProperty("fresh");
    expect(running.services).not.toHaveProperty("old");
    expect(
      (await request(running.server).get("/__wake/status").set("Host", "alias.example.test"))
        .status,
    ).toBe(200);
    expect((await request(running.server).get("/proxy/old/__wake/status")).status).toBe(404);

    fs.writeFileSync(configPath, "{ invalid");
    expect(await running.reloadConfig()).toBe(false);
    expect(running.services).toHaveProperty("fresh");
  });

  it("rebinds the HTTP listener and reconciles TCP listeners live", async () => {
    configDir = makeTempDir("wake-proxy-config-");
    const configPath = `${configDir}/config.json`;
    const proxyPort = await getFreePort();
    const nextProxyPort = await getFreePort();
    const tcpPort = await getFreePort();
    const config = {
      proxyPort,
      bindHost: "127.0.0.1",
      updateCheck: false,
      services: [{ route: "old", target: "http://127.0.0.1:1" }],
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    running = startServer(config, configPath);
    await waitUntil(() => running!.server.listening);
    const previousHttpServer = running.server;

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        proxyPort: nextProxyPort,
        services: [
          { route: "fresh", target: "http://127.0.0.1:1" },
          { route: "mc", target: "127.0.0.1:1", type: "tcp", listenPort: tcpPort },
        ],
      }),
    );
    expect(await running.reloadConfig()).toBe(true);
    await waitUntil(
      () =>
        listensOnPort(running!.server, nextProxyPort) &&
        running!.tcpProxies.length === 1 &&
        running!.tcpProxies[0].server.listening,
    );
    expect(previousHttpServer.listening).toBe(false);
    expect(running.services).toHaveProperty("fresh");
    expect(running.tcpProxies[0].listenPort).toBe(tcpPort);
    expect((await request(running.server).get("/healthz")).body.services).toBe(2);

    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, proxyPort: nextProxyPort, services: [] }),
    );
    expect(await running.reloadConfig()).toBe(true);
    await waitUntil(() => running!.tcpProxies.length === 0);
    expect(running.services).toEqual({});
  });

  it("keeps the active HTTP listener and config when a new address cannot bind", async () => {
    configDir = makeTempDir("wake-proxy-config-");
    const configPath = `${configDir}/config.json`;
    const proxyPort = await getFreePort();
    const blockedPort = await getFreePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(blockedPort, "127.0.0.1", resolve));
    const config = {
      proxyPort,
      bindHost: "127.0.0.1",
      updateCheck: false,
      services: [{ route: "old", target: "http://127.0.0.1:1" }],
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    running = startServer(config, configPath);
    await waitUntil(() => running!.server.listening);
    const previousHttpServer = running.server;

    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, proxyPort: blockedPort, services: [] }),
    );
    expect(await running.reloadConfig()).toBe(false);
    expect(running.server).toBe(previousHttpServer);
    expect(running.server.listening).toBe(true);
    expect(running.services).toHaveProperty("old");
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("keeps the active services when a new TCP listener cannot bind", async () => {
    configDir = makeTempDir("wake-proxy-config-");
    const configPath = `${configDir}/config.json`;
    const proxyPort = await getFreePort();
    const blockedPort = await getFreePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(blockedPort, "127.0.0.1", resolve));
    const config = {
      proxyPort,
      bindHost: "127.0.0.1",
      updateCheck: false,
      services: [{ route: "old", target: "http://127.0.0.1:1" }],
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    running = startServer(config, configPath);
    await waitUntil(() => running!.server.listening);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        services: [
          { route: "fresh", target: "http://127.0.0.1:1" },
          { route: "mc", target: "127.0.0.1:1", type: "tcp", listenPort: blockedPort },
        ],
      }),
    );
    expect(await running.reloadConfig()).toBe(false);
    expect(running.services).toHaveProperty("old");
    expect(running.services).not.toHaveProperty("fresh");
    expect(running.tcpProxies).toHaveLength(0);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
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
