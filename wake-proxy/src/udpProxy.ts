/**
 * UDP wake proxy for services that speak UDP (game servers, VPNs, voice...).
 *
 * Listens on `listenPort` and relays datagrams to `target`. Each client
 * (address + port) gets its own upstream socket, so replies find their way
 * back. A new client wakes the service if it is down; its datagrams are
 * queued (bounded) during the wake and delivered once the target answers.
 * Traffic in either direction counts as activity for idle shutdown, and a
 * client whose upstream stops answering (the service was stopped) is dropped
 * so its next datagram wakes the service again.
 */
import dgram from "dgram";
import { touchLastAccess } from "./lastAccess";
import { errorMessage, sleep } from "./util";
import { isUdpReady, parseHostPort, triggerWake, type WakeTarget } from "./wakeManager";

export interface UdpServiceConfig extends WakeTarget {
  route: string;
  listenPort: number;
}

export interface UdpProxyOptions {
  /** How long datagrams are queued while the service wakes (default 90s) */
  wakeTimeoutMs?: number;
  /** How often the target is probed during a wake (default 1s) */
  pollIntervalMs?: number;
  /** A client silent in both directions for this long is forgotten (default 3 min) */
  sessionTimeoutMs?: number;
  /** Datagrams queued per client during a wake; later ones are dropped (default 64) */
  maxQueuedPerClient?: number;
  /** Address to listen on (default `::`, which also receives IPv4 on Linux) */
  host?: string;
}

export interface UdpProxyHandle {
  socket: dgram.Socket;
  /** Number of clients currently known to the proxy. */
  clientCount(): number;
  /** Stop listening and drop every client. */
  close(): Promise<void>;
}

interface Client {
  upstream: dgram.Socket;
  lastSeen: number;
  /** Datagrams waiting for the service; `null` once they flow straight through */
  queue: Buffer[] | null;
  closed: boolean;
}

/** Start the UDP wake proxy for one service. */
export function startUdpProxy(
  svc: UdpServiceConfig,
  options: UdpProxyOptions = {},
): UdpProxyHandle {
  const wakeTimeoutMs = options.wakeTimeoutMs ?? 90_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? 180_000;
  const maxQueued = options.maxQueuedPerClient ?? 64;
  const listenHost = options.host ?? "::";
  const { host, port } = parseHostPort(svc.target);
  const clients = new Map<string, Client>();
  let closed = false;

  const server = dgram.createSocket(
    listenHost.includes(":") ? { type: "udp6", ipv6Only: false } : { type: "udp4" },
  );

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - sessionTimeoutMs;
      for (const [key, client] of clients) {
        if (client.lastSeen < cutoff) dropClient(key, client);
      }
    },
    Math.max(1000, sessionTimeoutMs / 3),
  );
  sweep.unref();

  server.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const key = `${rinfo.address}|${rinfo.port}`;
    const client = clients.get(key) ?? addClient(key, rinfo);
    client.lastSeen = Date.now();
    touchLastAccess(svc.route);
    if (client.queue === null) client.upstream.send(msg);
    else if (client.queue.length < maxQueued) client.queue.push(msg);
  });

  server.on("error", (e: Error) => {
    console.error(
      `UDP proxy for ${svc.route} failed on port ${svc.listenPort}: ${errorMessage(e)}`,
    );
  });

  server.bind(svc.listenPort, listenHost, () => {
    console.log(`UDP wake proxy for ${svc.route}: :${svc.listenPort} -> ${host}:${port}`);
  });

  function addClient(key: string, rinfo: dgram.RemoteInfo): Client {
    // Targets are host:port, so IPv4 (or a name resolving to it)
    const upstream = dgram.createSocket("udp4");
    const client: Client = { upstream, lastSeen: Date.now(), queue: [], closed: false };
    clients.set(key, client);

    upstream.on("message", (reply: Buffer) => {
      client.lastSeen = Date.now();
      touchLastAccess(svc.route);
      server.send(reply, rinfo.port, rinfo.address);
    });
    // On a connected socket, "port unreachable" from a stopped service
    // arrives as an error: forget the client so its next datagram wakes it
    upstream.on("error", () => dropClient(key, client));
    upstream.connect(port, host, () => void deliver(key, client));
    return client;
  }

  /** Wake the service if needed, then flush the client's queue and switch it to pass-through. */
  async function deliver(key: string, client: Client): Promise<void> {
    if (!(await isUdpReady(host, port))) {
      void triggerWake(svc.route, svc);
      const deadline = Date.now() + wakeTimeoutMs;
      let ready = false;
      while (!ready && !client.closed && Date.now() < deadline) {
        await sleep(pollIntervalMs);
        ready = await isUdpReady(host, port);
      }
      if (!ready) {
        dropClient(key, client);
        return;
      }
    }
    if (client.closed) return;
    const queued = client.queue as Buffer[];
    client.queue = null;
    for (const msg of queued) client.upstream.send(msg);
  }

  function dropClient(key: string, client: Client): void {
    if (client.closed) return;
    client.closed = true;
    // A key only ever maps to its one open client, so this is always that client
    clients.delete(key);
    client.upstream.close();
  }

  return {
    socket: server,
    clientCount: () => clients.size,
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        clearInterval(sweep);
        for (const [key, client] of clients) dropClient(key, client);
        server.close(() => resolve());
      }),
  };
}
