/**
 * Raw TCP wake proxy for non-HTTP services (game servers, databases, ...).
 *
 * Listens on `listenPort`; when a client connects while the backend is down,
 * it wakes the service, holds the connection until the backend port opens
 * (or the client gives up), then pipes bytes both ways.
 */
import net from "net";
import { triggerWake, isTcpReady, parseHostPort, type WakeTarget } from "./wakeManager";
import { touchLastAccess } from "./lastAccess";
import { errorMessage, sleep } from "./util";

export interface TcpServiceConfig extends WakeTarget {
  route: string;
  listenPort: number;
}

export interface TcpProxyOptions {
  /** How long a client is held while the service wakes (default 90s) */
  wakeTimeoutMs?: number;
  /** How often the backend port is probed during a wake (default 2s) */
  pollIntervalMs?: number;
  /** How often active sessions refresh the idle timer (default 60s) */
  keepAliveIntervalMs?: number;
}

export interface TcpProxyHandle {
  server: net.Server;
  listenPort: number;
  ready: Promise<boolean>;
  /** Update the service used for future connections without interrupting active sessions. */
  update(svc: TcpServiceConfig): void;
  /** Stop listening and drop every open connection. */
  close(): Promise<void>;
}

/** Start the TCP wake proxy for one service. */
export function startTcpProxy(
  svc: TcpServiceConfig,
  options: TcpProxyOptions = {},
): TcpProxyHandle {
  const wakeTimeoutMs = options.wakeTimeoutMs ?? 90_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const keepAliveIntervalMs = options.keepAliveIntervalMs ?? 60_000;
  let currentService = svc;
  const sockets = new Set<net.Socket>();
  const activeByRoute = new Map<string, number>();
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let readySettled = false;
  const settleReady = (value: boolean) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(value);
  };

  // Keep the idle timer fresh while long-lived sessions are connected
  const keepAlive = setInterval(() => {
    for (const [route, count] of activeByRoute) {
      if (count > 0) touchLastAccess(route);
    }
  }, keepAliveIntervalMs);
  keepAlive.unref();

  const server = net.createServer((client) => {
    client.on("error", () => {});
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    const connectionService = currentService;
    const { host, port } = parseHostPort(connectionService.target);
    touchLastAccess(connectionService.route);
    void handleConnection(client, connectionService, host, port);
  });

  async function handleConnection(
    client: net.Socket,
    connectionService: TcpServiceConfig,
    host: string,
    port: number,
  ): Promise<void> {
    // Fast path: backend already up
    if (await isTcpReady(host, port)) {
      pipe(client, connectionService.route, host, port);
      return;
    }

    void triggerWake(connectionService.route, connectionService);

    // Hold the client while the service wakes; many clients time out on
    // their own, so also stop waiting if the client hangs up
    const deadline = Date.now() + wakeTimeoutMs;
    let ready = false;
    while (!ready && !client.destroyed && Date.now() < deadline) {
      ready = await isTcpReady(host, port);
      if (!ready) await sleep(pollIntervalMs);
    }
    if (!ready || client.destroyed) {
      client.destroy();
      return;
    }
    pipe(client, connectionService.route, host, port);
  }

  function pipe(client: net.Socket, route: string, host: string, port: number): void {
    activeByRoute.set(route, (activeByRoute.get(route) ?? 0) + 1);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      const active = (activeByRoute.get(route) ?? 1) - 1;
      if (active === 0) activeByRoute.delete(route);
      else activeByRoute.set(route, active);
      touchLastAccess(route);
      client.destroy();
      backend.destroy();
    };

    const backend = net.connect(port, host);
    sockets.add(backend);
    backend.on("close", () => sockets.delete(backend));
    backend.on("error", done);
    client.on("error", done);
    backend.on("close", done);
    client.on("close", done);
    backend.on("connect", () => {
      client.pipe(backend);
      backend.pipe(client);
    });
  }

  server.on("error", (e: Error) => {
    settleReady(false);
    console.error(
      `TCP proxy for ${currentService.route} failed on port ${currentService.listenPort}: ${errorMessage(e)}`,
    );
  });

  try {
    server.listen(svc.listenPort, () => {
      settleReady(true);
      const { host, port } = parseHostPort(currentService.target);
      console.log(
        `TCP wake proxy for ${currentService.route}: :${currentService.listenPort} -> ${host}:${port}`,
      );
    });
  } catch (e) {
    settleReady(false);
    console.error(
      `TCP proxy for ${currentService.route} failed on port ${currentService.listenPort}: ${errorMessage(e)}`,
    );
  }

  return {
    server,
    listenPort: svc.listenPort,
    ready,
    update: (nextService) => {
      currentService = nextService;
    },
    close: () =>
      new Promise((resolve) => {
        clearInterval(keepAlive);
        for (const sock of sockets) sock.destroy();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}
