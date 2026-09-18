import net from "net";
import * as wakeManager from "../src/wakeManager";
import { startTcpProxy, type TcpProxyHandle } from "../src/tcpProxy";
import { getLastAccess } from "../src/lastAccess";
import { getFreePort, mockConsole, realSleep, useTempStateDir, waitUntil } from "./helpers";

jest.mock("../src/wakeManager", () => ({
  ...jest.requireActual("../src/wakeManager"),
  triggerWake: jest.fn(() => Promise.resolve()),
}));
const triggerWake = wakeManager.triggerWake as jest.MockedFunction<typeof wakeManager.triggerWake>;

const console = mockConsole();
useTempStateDir();

function startEcho(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.pipe(sock);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => resolve(sock));
    sock.on("error", reject);
  });
}

function roundTrip(sock: net.Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    sock.once("data", (data) => resolve(data.toString()));
    sock.write(message);
  });
}

const closed = (sock: net.Socket) =>
  new Promise<void>((resolve) => {
    if (sock.destroyed) resolve();
    else sock.once("close", () => resolve());
  });

let handle: TcpProxyHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function startProxy(
  svc: Parameters<typeof startTcpProxy>[0],
  options?: Parameters<typeof startTcpProxy>[1],
): Promise<TcpProxyHandle> {
  handle = startTcpProxy(svc, options);
  // `listening` flips before the listen callback (which logs) has run
  await new Promise<void>((resolve) => handle!.server.once("listening", resolve));
  return handle;
}

describe("startTcpProxy", () => {
  it("pipes bytes both ways when the backend is already up", async () => {
    const backendPort = await getFreePort();
    const echo = await startEcho(backendPort);
    const listenPort = await getFreePort();
    await startProxy({ route: "mc", target: `127.0.0.1:${backendPort}`, listenPort });
    expect(console.log).toHaveBeenCalledWith(
      `TCP wake proxy for mc: :${listenPort} -> 127.0.0.1:${backendPort}`,
    );

    const client = await connect(listenPort);
    expect(await roundTrip(client, "hello")).toBe("hello");
    expect(getLastAccess("mc")).not.toBeNull();
    expect(triggerWake).not.toHaveBeenCalled();

    client.destroy();
    await closeServer(echo);
  });

  it("wakes the service and holds the client until the backend port opens", async () => {
    const backendPort = await getFreePort();
    const listenPort = await getFreePort();
    const svc = { route: "mc", target: `127.0.0.1:${backendPort}`, listenPort, composeDir: "/x" };
    await startProxy(svc, { pollIntervalMs: 20 });

    const client = await connect(listenPort);
    await waitUntil(() => triggerWake.mock.calls.length === 1);
    expect(triggerWake).toHaveBeenCalledWith("mc", svc);

    await realSleep(50);
    const echo = await startEcho(backendPort);
    expect(await roundTrip(client, "ping")).toBe("ping");

    client.destroy();
    await closeServer(echo);
  });

  it("drops the client when the service does not come up in time", async () => {
    const listenPort = await getFreePort();
    await startProxy(
      { route: "mc", target: `127.0.0.1:${await getFreePort()}`, listenPort },
      { wakeTimeoutMs: 60, pollIntervalMs: 10 },
    );
    const client = await connect(listenPort);
    await closed(client);
    expect(triggerWake).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the client gives up first", async () => {
    const listenPort = await getFreePort();
    const proxy = await startProxy(
      { route: "mc", target: `127.0.0.1:${await getFreePort()}`, listenPort },
      { wakeTimeoutMs: 5000, pollIntervalMs: 10 },
    );
    const client = await connect(listenPort);
    await waitUntil(() => triggerWake.mock.calls.length === 1);
    client.resetAndDestroy(); // a hard reset is an error on the proxy's side, which it ignores
    await realSleep(50);
    await proxy.close(); // returns promptly: no held connection remains
    handle = undefined;
  });

  it("refreshes the idle timer while a session is active", async () => {
    const backendPort = await getFreePort();
    const echo = await startEcho(backendPort);
    const listenPort = await getFreePort();
    await startProxy(
      { route: "mc", target: `127.0.0.1:${backendPort}`, listenPort },
      { keepAliveIntervalMs: 15 },
    );

    const client = await connect(listenPort);
    await roundTrip(client, "x");
    const first = getLastAccess("mc")!;
    await waitUntil(() => getLastAccess("mc")! > first, 2000);

    client.destroy();
    await closed(client);
    await realSleep(40); // an idle keep-alive tick touches nothing
    await closeServer(echo);
  });

  it("ends the session when the backend closes the connection", async () => {
    const backendPort = await getFreePort();
    const server = net.createServer((sock) => {
      sock.on("error", () => {}); // the proxy resets what is left of the session
      sock.end("bye");
    });
    await new Promise<void>((resolve) => server.listen(backendPort, "127.0.0.1", resolve));
    const listenPort = await getFreePort();
    await startProxy({ route: "mc", target: `127.0.0.1:${backendPort}`, listenPort });

    const client = await connect(listenPort);
    const received = await new Promise<string>((resolve) =>
      client.once("data", (d) => resolve(d.toString())),
    );
    expect(received).toBe("bye");
    await closed(client);
    await closeServer(server);
  });

  it("logs when the listen port is unavailable", async () => {
    const port = await getFreePort();
    const blocker = await startEcho(port);
    handle = startTcpProxy({ route: "mc", target: "127.0.0.1:1", listenPort: port });
    await waitUntil(() => console.error.mock.calls.length > 0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^TCP proxy for mc failed on port \d+: .*EADDRINUSE/),
    );
    await closeServer(blocker);
  });
});
