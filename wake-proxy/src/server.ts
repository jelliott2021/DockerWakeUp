/**
 * Process-level wiring: the HTTP listener, the TCP wake proxies, the idle
 * checker and the update checker.
 */
import fs from "fs";
import path from "path";
import http from "http";
import { createApp } from "./app";
import {
  type Config,
  DEFAULT_BIND_HOST,
  DEFAULT_PROXY_PORT,
  indexServices,
  isTcpService,
  loadConfig,
  type ServiceMap,
} from "./config";
import { startIdleShutdownChecker } from "./idleShutdown";
import { startTcpProxy, type TcpProxyHandle } from "./tcpProxy";
import { startUpdateChecker } from "./updateChecker";

export interface RunningProxy {
  readonly server: http.Server;
  services: ServiceMap;
  tcpProxies: TcpProxyHandle[];
  /** Reload the watched config file; returns false when it could not be applied. */
  reloadConfig(): Promise<boolean>;
  /** Stop listening, drop open connections and cancel the timers. */
  close(): Promise<void>;
}

/** Hooks and `docker compose` run through the shell — fail fast when it is missing. */
export function assertShellAvailable(): void {
  if (!fs.existsSync("/bin/sh")) {
    throw new Error("/bin/sh does not exist or is not accessible");
  }
}

/** Where the HTTP proxy listens, with the documented defaults applied. */
export function listenAddress(config: Config): { port: number; host: string } {
  return {
    port: config.proxyPort || DEFAULT_PROXY_PORT,
    host: config.bindHost || DEFAULT_BIND_HOST,
  };
}

/** Start everything described by a config. */
export function startServer(config: Config, configPath?: string): RunningProxy {
  assertShellAvailable();
  const services = indexServices(config.services);
  const { app, handleUpgrade, updateServices } = createApp(config, services);

  const { port, host } = listenAddress(config);
  let activeServer = http.createServer(app);
  const httpServers = new Set([activeServer]);
  const closingHttpServers = new Map<http.Server, Promise<void>>();
  attachUpgradeHandler(activeServer);
  activeServer.on("error", (e) => {
    console.error(`HTTP proxy listener failed on ${host}:${port}:`, e);
  });
  activeServer.listen(port, host, () => {
    console.log(`Wake proxy listening on ${host}:${port}`);
  });

  const tcpProxies = Object.values(services)
    .filter(isTcpService)
    .map((svc) => startTcpProxy(svc));
  let idleTimer = startIdleShutdownChecker(services, config.idleThreshold);
  let updateTimer = config.updateCheck !== false ? startUpdateChecker() : null;
  let watcher: fs.FSWatcher | undefined;
  let reloadTimer: NodeJS.Timeout | undefined;
  let reloadInFlight: Promise<boolean> | undefined;
  let closed = false;

  async function reloadConfig(): Promise<boolean> {
    if (closed) return false;
    if (reloadInFlight) return reloadInFlight;
    reloadInFlight = performReload().finally(() => {
      reloadInFlight = undefined;
    });
    return reloadInFlight;
  }

  async function performReload(): Promise<boolean> {
    if (!configPath) return false;
    let nextConfig: Config;
    try {
      nextConfig = loadConfig(configPath);
    } catch (e) {
      console.error(`Config reload failed; keeping current config:`, e);
      return false;
    }

    const nextAddress = listenAddress(nextConfig);
    const nextServices = indexServices(nextConfig.services);
    const nextTcpServices = Object.values(nextServices).filter(isTcpService);
    const nextTcpByPort = new Map<number, (typeof nextTcpServices)[number]>();
    for (const svc of nextTcpServices) {
      if (nextTcpByPort.has(svc.listenPort)) {
        console.error(
          `Config reload failed: multiple TCP services use listenPort ${svc.listenPort}`,
        );
        return false;
      }
      nextTcpByPort.set(svc.listenPort, svc);
    }

    await Promise.all(tcpProxies.map((proxy) => proxy.ready));
    const currentTcpByPort = new Map(
      tcpProxies
        .filter((proxy) => proxy.server.listening)
        .map((proxy) => [proxy.listenPort, proxy]),
    );
    const stagedTcp: TcpProxyHandle[] = [];
    for (const [listenPort, svc] of nextTcpByPort) {
      if (currentTcpByPort.has(listenPort)) continue;
      const proxy = startTcpProxy(svc);
      stagedTcp.push(proxy);
      if (!(await proxy.ready)) {
        await Promise.all(stagedTcp.map((staged) => staged.close()));
        console.error(`Config reload failed: cannot bind TCP listener on port ${listenPort}`);
        return false;
      }
    }

    const currentAddress = listenAddress(config);
    let stagedHttp: http.Server | undefined;
    if (currentAddress.port !== nextAddress.port || currentAddress.host !== nextAddress.host) {
      stagedHttp = http.createServer(app);
      attachUpgradeHandler(stagedHttp);
      stagedHttp.on("error", (e) => {
        console.error(`HTTP proxy listener failed on ${nextAddress.host}:${nextAddress.port}:`, e);
      });
      try {
        await listenHttpServer(stagedHttp, nextAddress.port, nextAddress.host);
      } catch (e) {
        await Promise.all(stagedTcp.map((staged) => staged.close()));
        console.error(
          `Config reload failed: cannot bind HTTP listener on ${nextAddress.host}:${nextAddress.port}:`,
          e,
        );
        return false;
      }
      httpServers.add(stagedHttp);
      console.log(`Wake proxy listening on ${nextAddress.host}:${nextAddress.port}`);
    }

    const idleThresholdChanged = config.idleThreshold !== nextConfig.idleThreshold;
    const updateCheckChanged = config.updateCheck !== nextConfig.updateCheck;
    const previousTcp = [...tcpProxies];
    for (const [listenPort, svc] of nextTcpByPort) {
      const existing = currentTcpByPort.get(listenPort);
      if (existing) existing.update(svc);
    }
    const nextTcpHandles = [...nextTcpByPort.keys()].map(
      (listenPort) =>
        currentTcpByPort.get(listenPort) ??
        stagedTcp.find((proxy) => proxy.listenPort === listenPort)!,
    );
    tcpProxies.splice(0, tcpProxies.length, ...nextTcpHandles);
    for (const key of Object.keys(config) as (keyof Config)[]) {
      if (!(key in nextConfig)) Reflect.deleteProperty(config, key);
    }
    Object.assign(config, nextConfig);
    updateServices(nextServices);

    if (stagedHttp) {
      const previousServer = activeServer;
      activeServer = stagedHttp;
      void closeHttpServer(previousServer, false).catch((e) => {
        console.error("Failed to close previous HTTP listener:", e);
      });
    }

    const retainedTcp = new Set(nextTcpHandles);
    await Promise.all(
      previousTcp.filter((proxy) => !retainedTcp.has(proxy)).map((proxy) => proxy.close()),
    );

    if (idleThresholdChanged) {
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = startIdleShutdownChecker(services, config.idleThreshold);
    }
    if (updateCheckChanged) {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = config.updateCheck !== false ? startUpdateChecker() : null;
    }
    console.log("Config reloaded");
    return true;
  }

  function attachUpgradeHandler(server: http.Server): void {
    server.on("upgrade", handleUpgrade);
  }

  function listenHttpServer(
    server: http.Server,
    listenPort: number,
    listenHost: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(listenPort, listenHost);
    });
  }

  function closeHttpServer(server: http.Server, dropConnections: boolean): Promise<void> {
    const existing = closingHttpServers.get(server);
    if (existing) {
      if (dropConnections) server.closeAllConnections();
      return existing;
    }
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        httpServers.delete(server);
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
        } else {
          resolve();
        }
      });
      if (dropConnections) server.closeAllConnections();
    });
    closingHttpServers.set(server, closing);
    return closing;
  }

  if (configPath) {
    try {
      watcher = fs.watch(path.dirname(configPath), (_event, filename) => {
        if (filename && filename.toString() !== path.basename(configPath)) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined;
          void reloadConfig().catch((e) => {
            console.error("Config reload failed; keeping current config:", e);
          });
        }, 100);
        reloadTimer.unref();
      });
      watcher.on("error", (e) => {
        console.error(`Config file watcher failed for ${configPath}:`, e);
      });
    } catch (e) {
      console.error(`Cannot watch config file ${configPath}:`, e);
    }
  }

  return {
    get server() {
      return activeServer;
    },
    services,
    tcpProxies,
    reloadConfig,
    close: async () => {
      if (closed) throw new Error("Server is not running.");
      closed = true;
      watcher?.close();
      if (reloadTimer) clearTimeout(reloadTimer);
      if (reloadInFlight) await reloadInFlight;
      if (idleTimer) clearInterval(idleTimer);
      if (updateTimer) clearInterval(updateTimer);
      await Promise.all(tcpProxies.map((proxy) => proxy.close()));
      await Promise.all([...httpServers].map((server) => closeHttpServer(server, true)));
    },
  };
}
