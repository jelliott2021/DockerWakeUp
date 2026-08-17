import net from "net";
import { triggerWake, isTcpReady, parseHostPort, WakeTarget } from "./wakeManager";
import { touchLastAccess } from "./lastAccess";

export interface TcpServiceConfig extends WakeTarget {
  route: string;
  listenPort: number;
}

/**
 * Raw TCP wake proxy for non-HTTP services (game servers, databases, ...).
 * Listens on `listenPort`; when a client connects while the backend is down,
 * it wakes the service, holds the connection until the backend port opens
 * (or the client gives up), then pipes bytes both ways.
 */
export function startTcpProxy(svc: TcpServiceConfig): void {
  const { host, port } = parseHostPort(svc.target);
  let activeConnections = 0;

  // Keep the idle timer fresh while long-lived sessions are connected
  setInterval(() => {
    if (activeConnections > 0) touchLastAccess(svc.route);
  }, 60_000);

  const server = net.createServer((client) => {
    client.on("error", () => { });
    touchLastAccess(svc.route);
    handleConnection(client);
  });

  async function handleConnection(client: net.Socket): Promise<void> {
    // Fast path: backend already up
    if (await isTcpReady(host, port)) {
      return pipe(client);
    }

    triggerWake(svc.route, svc);

    // Hold the client while the service wakes; many clients time out on
    // their own, so also stop waiting if the client hangs up
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !client.destroyed) {
      if (await isTcpReady(host, port)) {
        if (!client.destroyed) pipe(client);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    client.destroy();
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
    backend.on("error", done);
    client.on("error", done);
    backend.on("close", done);
    client.on("close", done);
    backend.on("connect", () => {
      client.pipe(backend);
      backend.pipe(client);
    });
  }

  server.on("error", (e: any) => {
    console.error(`TCP proxy for ${svc.route} failed on port ${svc.listenPort}: ${e?.message ?? e}`);
  });

  server.listen(svc.listenPort, () => {
    console.log(`TCP wake proxy for ${svc.route}: :${svc.listenPort} -> ${host}:${port}`);
  });
}
