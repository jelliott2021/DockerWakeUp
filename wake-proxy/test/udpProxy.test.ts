import dgram from "dgram";
import * as wakeManager from "../src/wakeManager";
import { startUdpProxy, type UdpProxyHandle, type UdpProxyOptions } from "../src/udpProxy";
import { getLastAccess } from "../src/lastAccess";
import { getFreeUdpPort, mockConsole, realSleep, useTempStateDir, waitUntil } from "./helpers";

jest.mock("../src/wakeManager", () => {
  const actual = jest.requireActual("../src/wakeManager");
  return {
    ...actual,
    triggerWake: jest.fn(() => Promise.resolve()),
    isUdpReady: jest.fn(actual.isUdpReady),
  };
});
const triggerWake = wakeManager.triggerWake as jest.MockedFunction<typeof wakeManager.triggerWake>;
const isUdpReady = wakeManager.isUdpReady as jest.MockedFunction<typeof wakeManager.isUdpReady>;
const { isUdpReady: realIsUdpReady } = jest.requireActual<typeof wakeManager>("../src/wakeManager");

const console = mockConsole();
useTempStateDir();

/** A UDP backend that answers every datagram with "echo:<datagram>". */
interface Echo {
  received: string[];
  close(): Promise<void>;
}
function startEcho(port: number): Promise<Echo> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const received: string[] = [];
    sock.on("message", (msg, rinfo) => {
      if (msg.length === 0) return; // readiness probes
      received.push(msg.toString());
      sock.send(`echo:${msg}`, rinfo.port, rinfo.address);
    });
    sock.bind(port, "127.0.0.1", () =>
      resolve({
        received,
        close: () => new Promise<void>((done) => sock.close(() => done())),
      }),
    );
  });
}

/** A client socket that collects every reply. */
interface Client {
  replies: string[];
  send(msg: string): Promise<void>;
  close(): void;
}
function client(proxyPort: number): Client {
  const sock = dgram.createSocket("udp4");
  const replies: string[] = [];
  sock.on("message", (msg) => replies.push(msg.toString()));
  return {
    replies,
    send: (msg) =>
      new Promise((resolve, reject) =>
        sock.send(msg, proxyPort, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
      ),
    close: () => sock.close(),
  };
}

let listenPort: number;
let backendPort: number;
let handle: UdpProxyHandle | undefined;
let echo: Echo | undefined;
const clients: Client[] = [];

beforeEach(async () => {
  // Implementations set by one test must not leak into the next
  triggerWake.mockReset();
  triggerWake.mockResolvedValue();
  isUdpReady.mockReset();
  isUdpReady.mockImplementation(realIsUdpReady);
  listenPort = await getFreeUdpPort();
  backendPort = await getFreeUdpPort();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await handle?.close();
  await echo?.close();
  handle = undefined;
  echo = undefined;
});

async function startProxy(options: UdpProxyOptions = {}): Promise<UdpProxyHandle> {
  handle = startUdpProxy(
    { route: "vpn", target: `127.0.0.1:${backendPort}`, listenPort, composeDir: "/x" },
    { host: "127.0.0.1", pollIntervalMs: 20, ...options },
  );
  await waitUntil(() =>
    console.log.mock.calls.some((call) => String(call[0]).startsWith("UDP wake proxy for vpn")),
  );
  return handle;
}

function newClient(): Client {
  const c = client(listenPort);
  clients.push(c);
  return c;
}

describe("startUdpProxy", () => {
  it("relays both ways to a running service and counts it as activity", async () => {
    echo = await startEcho(backendPort);
    await startProxy();
    expect(console.log).toHaveBeenCalledWith(
      `UDP wake proxy for vpn: :${listenPort} -> 127.0.0.1:${backendPort}`,
    );
    const c = newClient();
    await c.send("one");
    await waitUntil(() => c.replies.length === 1);
    await c.send("two");
    await waitUntil(() => c.replies.length === 2);
    expect(c.replies).toEqual(["echo:one", "echo:two"]);
    expect(handle!.clientCount()).toBe(1);
    expect(triggerWake).not.toHaveBeenCalled();
    expect(getLastAccess("vpn")).not.toBeNull();
  });

  it("keeps one upstream per client", async () => {
    echo = await startEcho(backendPort);
    await startProxy();
    const [a, b] = [newClient(), newClient()];
    await a.send("a");
    await b.send("b");
    await waitUntil(() => a.replies.length === 1 && b.replies.length === 1);
    expect(a.replies).toEqual(["echo:a"]);
    expect(b.replies).toEqual(["echo:b"]);
    expect(handle!.clientCount()).toBe(2);
  });

  it("wakes a stopped service and delivers what arrived meanwhile, in order", async () => {
    triggerWake.mockImplementation(async () => {
      await realSleep(50);
      echo = await startEcho(backendPort);
    });
    await startProxy();
    const c = newClient();
    await c.send("1");
    await c.send("2");
    await c.send("3");
    await waitUntil(() => c.replies.length === 3);
    expect(triggerWake).toHaveBeenCalledTimes(1);
    expect(triggerWake).toHaveBeenCalledWith("vpn", expect.objectContaining({ route: "vpn" }));
    expect(c.replies).toEqual(["echo:1", "echo:2", "echo:3"]);
  });

  it("queues only a bounded number of datagrams per client during a wake", async () => {
    triggerWake.mockImplementation(async () => {
      await realSleep(80);
      echo = await startEcho(backendPort);
    });
    await startProxy({ maxQueuedPerClient: 2 });
    const c = newClient();
    for (const msg of ["1", "2", "3", "4"]) await c.send(msg);
    await waitUntil(() => c.replies.length === 2);
    await realSleep(50);
    expect(c.replies).toEqual(["echo:1", "echo:2"]);
  });

  it("drops a client whose wake times out, so its next datagram tries again", async () => {
    await startProxy({ wakeTimeoutMs: 60 });
    const c = newClient();
    await c.send("hello");
    await waitUntil(() => triggerWake.mock.calls.length === 1);
    await waitUntil(() => handle!.clientCount() === 0);
    await c.send("again");
    await waitUntil(() => triggerWake.mock.calls.length === 2);
  });

  it("drops a client when the service goes away mid-session", async () => {
    echo = await startEcho(backendPort);
    await startProxy();
    const c = newClient();
    await c.send("up");
    await waitUntil(() => c.replies.length === 1);
    await echo.close();
    echo = undefined;
    // The next datagram meets "port unreachable"; the one after that wakes the service
    await c.send("lost");
    await waitUntil(() => handle!.clientCount() === 0);
    await c.send("wake");
    await waitUntil(() => triggerWake.mock.calls.length === 1);
  });

  it("forgets clients that have been silent for the session timeout", async () => {
    echo = await startEcho(backendPort);
    await startProxy({ sessionTimeoutMs: 50 });
    const c = newClient();
    await c.send("hi");
    await waitUntil(() => c.replies.length === 1);
    expect(handle!.clientCount()).toBe(1);
    // The sweep runs at most once a second
    await waitUntil(() => handle!.clientCount() === 0, 3000);
  });

  it("keeps clients that are still talking when the sweep runs", async () => {
    echo = await startEcho(backendPort);
    await startProxy({ sessionTimeoutMs: 300 });
    const [quiet, busy] = [newClient(), newClient()];
    await quiet.send("once");
    let talking = true;
    const chatter = (async () => {
      while (talking) {
        await busy.send("ping");
        await realSleep(50);
      }
    })();
    // Past one sweep (1s): the quiet client is gone, the busy one isn't
    await waitUntil(() => handle!.clientCount() === 1, 3000);
    talking = false;
    await chatter;
    expect(busy.replies.length).toBeGreaterThan(0);
    const before = busy.replies.length;
    await busy.send("still here");
    await waitUntil(() => busy.replies.length > before);
  });

  it("stops delivering to a client closed while its wake finishes", async () => {
    let finishWake!: () => void;
    isUdpReady
      .mockResolvedValueOnce(false) // first probe: service down
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishWake = () => resolve(true);
          }),
      );
    await startProxy();
    const c = newClient();
    await c.send("x");
    await waitUntil(() => finishWake !== undefined);
    await handle!.close(); // drops the client mid-wake
    finishWake();
    await realSleep(20);
    expect(handle!.clientCount()).toBe(0);
    expect(isUdpReady).toHaveBeenCalledTimes(2);
  });

  it("reports a port it can't listen on and still closes cleanly", async () => {
    const squatter = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => squatter.bind(listenPort, "127.0.0.1", resolve));
    handle = startUdpProxy(
      { route: "vpn", target: `127.0.0.1:${backendPort}`, listenPort },
      { host: "127.0.0.1" },
    );
    await waitUntil(() => console.error.mock.calls.length > 0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`UDP proxy for vpn failed on port ${listenPort}: `),
    );
    await handle.close();
    await handle.close(); // idempotent
    handle = undefined;
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });

  it("listens dual-stack by default, so IPv4 clients reach it", async () => {
    echo = await startEcho(backendPort);
    handle = startUdpProxy({ route: "vpn", target: `127.0.0.1:${backendPort}`, listenPort });
    await waitUntil(() => console.log.mock.calls.length > 0);
    expect(handle.socket.address().address).toBe("::");
    const c = newClient();
    await c.send("v4");
    await waitUntil(() => c.replies.length === 1);
    expect(await realIsUdpReady("127.0.0.1", backendPort)).toBe(true);
  });
});
