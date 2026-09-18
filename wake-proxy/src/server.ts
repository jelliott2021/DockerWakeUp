/**
 * Process-level wiring: the HTTP listener, the TCP wake proxies, the idle
 * checker and the update checker.
 */
import fs from "fs";
import type http from "http";
import { createApp } from "./app";
import {
  type Config,
  DEFAULT_BIND_HOST,
  DEFAULT_PROXY_PORT,
  indexServices,
  isTcpService,
  type ServiceMap,
} from "./config";
import { startIdleShutdownChecker } from "./idleShutdown";
import { startTcpProxy, type TcpProxyHandle } from "./tcpProxy";
import { startUpdateChecker } from "./updateChecker";

export interface RunningProxy {
  server: http.Server;
  services: ServiceMap;
  tcpProxies: TcpProxyHandle[];
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
export function startServer(config: Config): RunningProxy {
  assertShellAvailable();
  const services = indexServices(config.services);
  const { app, handleUpgrade } = createApp(config, services);

  const { port, host } = listenAddress(config);
  const server = app.listen(port, host, () => {
    console.log(`Wake proxy listening on ${host}:${port}`);
  });
  server.on("upgrade", handleUpgrade);

  const tcpProxies = Object.values(services)
    .filter(isTcpService)
    .map((svc) => startTcpProxy(svc));
  const idleTimer = startIdleShutdownChecker(services, config.idleThreshold);
  const updateTimer = config.updateCheck !== false ? startUpdateChecker() : null;

  return {
    server,
    services,
    tcpProxies,
    close: async () => {
      if (idleTimer) clearInterval(idleTimer);
      if (updateTimer) clearInterval(updateTimer);
      await Promise.all(tcpProxies.map((proxy) => proxy.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
