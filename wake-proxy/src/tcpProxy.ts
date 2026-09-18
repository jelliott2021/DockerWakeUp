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
  const { host, port } = parseHostPort(svc.target);
  const sockets = new Set<net.Socket>();
  let activeConnections = 0;

  // Keep the idle timer fresh while long-lived sessions are connected
  const keepAlive = setInterval(() => {
    if (activeConnections > 0) touchLastAccess(svc.route);
  }, keepAliveIntervalMs);
  keepAlive.unref();

  const server = net.createServer((client) => {
    client.on("error", () => {});
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    touchLastAccess(svc.route);
    void handleConnection(client);
  });

  async function handleConnection(client: net.Socket): Promise<void> {
    // Fast path: backend already up
    if (await isTcpReady(host, port)) {
      pipe(client);
      return;
    }

    void triggerWake(svc.route, svc);

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
    pipe(client);
  }

  function pipe(client: net.Socket): void {
    activeConnections++;
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      activeConnections--;
      touchLastAccess(svc.route);
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
    console.error(
      `TCP proxy for ${svc.route} failed on port ${svc.listenPort}: ${errorMessage(e)}`,
    );
  });

  server.listen(svc.listenPort, () => {
    console.log(`TCP wake proxy for ${svc.route}: :${svc.listenPort} -> ${host}:${port}`);
  });

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        clearInterval(keepAlive);
        for (const sock of sockets) sock.destroy();
        server.close(() => resolve());
      }),
  };
}
