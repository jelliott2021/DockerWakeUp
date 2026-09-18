import childProcess from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import net from "net";
import path from "path";
import * as shell from "../src/shell";
import { CommandError } from "../src/shell";
import {
  DEFAULT_LOG_TAIL,
  FAILED_RETRY_MS,
  getExpectedWakeMs,
  getWakeStatus,
  isHttpReady,
  isServiceReady,
  isTcpReady,
  parseHostPort,
  resetWakeStatuses,
  streamServiceLogs,
  triggerWake,
  waitForReady,
} from "../src/wakeManager";
import { getLastAccess, getWakeDurations, recordWakeDuration } from "../src/lastAccess";
import {
  getFreePort,
  makeTempDir,
  mockConsole,
  realSleep,
  startMockBackend,
  useTempStateDir,
  waitUntil,
  type MockBackend,
} from "./helpers";

jest.mock("../src/shell", () => ({
  ...jest.requireActual("../src/shell"),
  runShell: jest.fn(),
  runFile: jest.fn(),
}));
const runShell = shell.runShell as jest.MockedFunction<typeof shell.runShell>;
const runFile = shell.runFile as jest.MockedFunction<typeof shell.runFile>;
const { runFile: runFileReal } = jest.requireActual<typeof shell>("../src/shell");
const ok = { stdout: "", stderr: "" };

const console = mockConsole();
useTempStateDir();

let backend: MockBackend;
let composeDir: string;
beforeAll(async () => {
  backend = await startMockBackend();
});
afterAll(() => backend.close());
beforeEach(() => {
  resetWakeStatuses();
  composeDir = makeTempDir("compose-");
  fs.writeFileSync(path.join(composeDir, "compose.yml"), "services: {}\n");
});
afterEach(() => fs.rmSync(composeDir, { recursive: true, force: true }));

describe("parseHostPort", () => {
  it("accepts host:port with an optional scheme and path", () => {
    expect(parseHostPort("localhost:25565")).toEqual({ host: "localhost", port: 25565 });
    expect(parseHostPort("tcp://db.internal:5432")).toEqual({ host: "db.internal", port: 5432 });
    expect(parseHostPort("http://127.0.0.1:8096/health")).toEqual({
      host: "127.0.0.1",
      port: 8096,
    });
    expect(parseHostPort("https://host:443")).toEqual({ host: "host", port: 443 });
  });

  it("defaults the host to localhost and leaves a missing port NaN", () => {
    expect(parseHostPort(":9000")).toEqual({ host: "localhost", port: 9000 });
    expect(parseHostPort("host")).toEqual({ host: "host", port: NaN });
  });
});

describe("readiness probes", () => {
  it("isTcpReady: true for a listening port, false for a closed one", async () => {
    expect(await isTcpReady("127.0.0.1", backend.port)).toBe(true);
    expect(await isTcpReady("127.0.0.1", await getFreePort())).toBe(false);
  });

  it("isTcpReady: false when the connection times out", async () => {
    const sock = Object.assign(new EventEmitter(), { setTimeout: jest.fn(), destroy: jest.fn() });
    jest.spyOn(net, "connect").mockReturnValue(sock as unknown as net.Socket);
    const probe = isTcpReady("10.255.255.1", 1, 50);
    sock.emit("timeout");
    sock.emit("connect"); // late events after settling are ignored
    expect(await probe).toBe(false);
    expect(sock.setTimeout).toHaveBeenCalledWith(50);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it("isHttpReady: any answer below 500 counts as ready, errors do not", async () => {
    expect(await isHttpReady(backend.url)).toBe(true);
    const unauthorized = await startMockBackend((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    expect(await isHttpReady(unauthorized.url)).toBe(true);
    await unauthorized.close();
    const broken = await startMockBackend((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    expect(await isHttpReady(broken.url)).toBe(false);
    await broken.close();
    expect(await isHttpReady(`http://127.0.0.1:${await getFreePort()}`)).toBe(false);
  });

  it("isServiceReady picks the probe by service type", async () => {
    expect(await isServiceReady({ target: backend.url })).toBe(true);
    expect(await isServiceReady({ target: backend.hostPort, type: "tcp" })).toBe(true);
    expect(await isServiceReady({ target: `127.0.0.1:${await getFreePort()}`, type: "tcp" })).toBe(
      false,
    );
  });

  it("waitForReady resolves once ready and rejects after the timeout", async () => {
    await expect(waitForReady({ target: backend.url }, 1000, 10)).resolves.toBeUndefined();
    await expect(waitForReady({ target: backend.url })).resolves.toBeUndefined(); // defaults
    const target = `http://127.0.0.1:${await getFreePort()}`;
    await expect(waitForReady({ target }, 60, 10)).rejects.toThrow(
      `Timeout: ${target} did not become ready`,
    );
  });
});

describe("getExpectedWakeMs", () => {
  it("is null without history and the median otherwise", () => {
    expect(getExpectedWakeMs("app")).toBeNull();
    for (const ms of [5000, 1000, 3000]) recordWakeDuration("app", ms);
    expect(getExpectedWakeMs("app")).toBe(3000);
    recordWakeDuration("app", 9000);
    expect(getExpectedWakeMs("app")).toBe(5000); // upper median for an even count
  });
});

describe("triggerWake", () => {
  it("reports services that were never woken as idle", () => {
    expect(getWakeStatus("never")).toEqual({ state: "idle" });
  });

  it("fails immediately when there is nothing to run", async () => {
    await triggerWake("app", { target: backend.url });
    expect(getWakeStatus("app")).toEqual({
      state: "failed",
      startedAt: expect.any(Number),
      error: "Service has no composeDir and no startCommand — nothing to run. Check config.json",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to wake service app:"),
    );
    expect(runShell).not.toHaveBeenCalled();
  });

  it("fails immediately when the compose directory is missing", async () => {
    await triggerWake("app", { target: backend.url, composeDir: "/definitely/missing" });
    expect(getWakeStatus("app").error).toBe(
      "Compose directory not found: /definitely/missing — check this service's composeDir in config.json",
    );
    expect(runShell).not.toHaveBeenCalled();
  });

  it("brings a compose service up, waits for it and records the wake", async () => {
    runShell.mockResolvedValue(ok);
    await triggerWake("app", { target: backend.url, composeDir });
    expect(runShell).toHaveBeenCalledWith("docker compose up -d", composeDir);
    expect(getWakeStatus("app")).toEqual({ state: "ready", startedAt: expect.any(Number) });
    expect(getWakeDurations("app")).toHaveLength(1);
    expect(getLastAccess("app")).not.toBeNull();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Service app is ready \(\d+\.\ds\)$/),
    );
  });

  it("uses the tcp probe for tcp services", async () => {
    runShell.mockResolvedValue(ok);
    await triggerWake("mc", { target: backend.hostPort, type: "tcp", composeDir });
    expect(getWakeStatus("mc").state).toBe("ready");
  });

  it("is a no-op while a wake is already in progress", async () => {
    let release!: () => void;
    runShell.mockReturnValue(new Promise((resolve) => (release = () => resolve(ok))));
    const first = triggerWake("app", { target: backend.url, composeDir });
    await triggerWake("app", { target: backend.url, composeDir });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(getWakeStatus("app").state).toBe("starting");
    release();
    await first;
    expect(getWakeStatus("app").state).toBe("ready");
  });

  it("does not retry a failed wake within FAILED_RETRY_MS, but does afterwards", async () => {
    await triggerWake("app", { target: backend.url });
    expect(getWakeStatus("app").state).toBe("failed");
    runShell.mockResolvedValue(ok);
    await triggerWake("app", { target: backend.url, composeDir });
    expect(runShell).not.toHaveBeenCalled();

    const later = Date.now() + FAILED_RETRY_MS + 1;
    jest.spyOn(Date, "now").mockReturnValue(later);
    await triggerWake("app", { target: backend.url, composeDir });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(getWakeStatus("app").state).toBe("ready");
  });

  it("runs a startCommand-only service's hook as the whole start", async () => {
    runShell.mockResolvedValue(ok);
    await triggerWake("app", { target: backend.url, startCommand: "./start.sh" });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenCalledWith("./start.sh", undefined);
    expect(getWakeStatus("app").state).toBe("ready");
  });

  it("fails the wake when a startCommand-only hook fails, logging its stderr", async () => {
    runShell.mockRejectedValue(new CommandError("Command failed: ./start.sh", "no such file\n"));
    await triggerWake("app", { target: backend.url, startCommand: "./start.sh" });
    expect(getWakeStatus("app")).toEqual({
      state: "failed",
      startedAt: expect.any(Number),
      error: "Command failed: ./start.sh",
    });
    expect(console.error).toHaveBeenCalledWith("no such file\n");
  });

  it("logs a failing pre-start hook but continues with docker compose", async () => {
    runShell.mockRejectedValueOnce(new Error("hook exploded")).mockResolvedValueOnce(ok);
    await triggerWake("app", { target: backend.url, composeDir, startCommand: "./prepare.sh" });
    expect(runShell).toHaveBeenNthCalledWith(1, "./prepare.sh", composeDir);
    expect(runShell).toHaveBeenNthCalledWith(2, "docker compose up -d", composeDir);
    expect(console.error).toHaveBeenCalledWith(
      "startCommand for app failed (continuing):",
      "hook exploded",
    );
    expect(getWakeStatus("app").state).toBe("ready");
  });

  it("fails when docker compose fails, pointing out a missing compose file", async () => {
    fs.rmSync(path.join(composeDir, "compose.yml"));
    runShell.mockRejectedValue(
      new CommandError("Command failed", "no configuration file provided\n"),
    );
    await triggerWake("app", { target: backend.url, composeDir });
    expect(getWakeStatus("app").state).toBe("failed");
    expect(console.error).toHaveBeenCalledWith(
      `Missing compose file in ${composeDir}. Expected one of: docker-compose.yml, docker-compose.yaml, compose.yml, compose.yaml`,
    );
    expect(console.error).toHaveBeenCalledWith("no configuration file provided\n");
    expect(runFile).not.toHaveBeenCalled();
  });

  it("propagates unexpected (non-command) errors from docker compose", async () => {
    runShell.mockRejectedValue(new Error("spawn EAGAIN"));
    await triggerWake("app", { target: backend.url, composeDir });
    expect(getWakeStatus("app").error).toBe("spawn EAGAIN");
  });

  const conflict = new CommandError(
    "Command failed",
    'Error response from daemon: Conflict. The container name "/jellyfin" is already in use by container "abc"',
  );

  it("removes a conflicting container and retries docker compose", async () => {
    runShell.mockRejectedValueOnce(conflict).mockResolvedValueOnce(ok);
    runFile.mockResolvedValue(ok);
    await triggerWake("app", { target: backend.url, composeDir });
    expect(runFile).toHaveBeenCalledWith("docker", ["rm", "-f", "/jellyfin"]);
    expect(runShell).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "Container conflict detected: /jellyfin. Attempting to remove...",
    );
    expect(console.log).toHaveBeenCalledWith("Removed /jellyfin. Retrying docker compose...");
    expect(getWakeStatus("app").state).toBe("ready");
  });

  it("fails when the conflicting container cannot be removed", async () => {
    runShell.mockRejectedValue(conflict);
    runFile.mockRejectedValue(new CommandError("Command failed: docker rm", "permission denied\n"));
    await triggerWake("app", { target: backend.url, composeDir });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to remove conflicting container: permission denied\n",
    );
    expect(getWakeStatus("app").error).toBe("Command failed: docker rm");
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("reports a non-command error from the container removal", async () => {
    runShell.mockRejectedValue(conflict);
    runFile.mockRejectedValue(new Error("weird"));
    await triggerWake("app", { target: backend.url, composeDir });
    expect(console.error).toHaveBeenCalledWith("Failed to remove conflicting container: weird");
  });

  it("fails when the retry after a conflict fails too", async () => {
    runShell
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(new CommandError("Command failed", "still broken\n"));
    runFile.mockResolvedValue(ok);
    await triggerWake("app", { target: backend.url, composeDir });
    expect(console.error).toHaveBeenCalledWith("Retry failed: still broken\n");
    expect(getWakeStatus("app").state).toBe("failed");

    resetWakeStatuses();
    runShell.mockRejectedValueOnce(conflict).mockRejectedValueOnce(new Error("odd"));
    await triggerWake("app", { target: backend.url, composeDir });
    expect(console.error).toHaveBeenCalledWith("Retry failed: odd");
  });

  it("fails when the service never becomes ready", async () => {
    runShell.mockResolvedValue(ok);
    const target = `http://127.0.0.1:${await getFreePort()}`;
    await triggerWake("app", { target, composeDir }, 30);
    expect(getWakeStatus("app").error).toBe(`Timeout: ${target} did not become ready`);
  });
});

describe("streamServiceLogs", () => {
  it("streams the lines of a custom logsCommand and stops on request", async () => {
    const lines: string[] = [];
    const stop = streamServiceLogs(
      { logsCommand: "printf 'one\\ntwo\\r\\n\\n  \\nthree'; sleep 5" },
      (line) => lines.push(line),
    );
    await waitUntil(() => lines.length >= 2);
    expect(lines).toEqual(["one", "two"]); // "three" has no newline yet, blanks are dropped
    stop();
  });

  it("runs the logsCommand in the compose directory when it exists", async () => {
    const lines: string[] = [];
    const stop = streamServiceLogs({ composeDir, logsCommand: "pwd" }, (line) => lines.push(line));
    await waitUntil(() => lines.length >= 1);
    expect(lines[0]).toBe(composeDir);
    stop();

    const elsewhere: string[] = [];
    const stop2 = streamServiceLogs({ composeDir: "/nope", logsCommand: "pwd" }, (l) =>
      elsewhere.push(l),
    );
    await waitUntil(() => elsewhere.length >= 1);
    expect(elsewhere[0]).not.toBe("/nope");
    stop2();
  });

  it("explains when there is nothing to stream", () => {
    const lines: string[] = [];
    streamServiceLogs({}, (line) => lines.push(line))();
    streamServiceLogs({ composeDir: "/missing/dir" }, (line) => lines.push(line))();
    expect(lines).toEqual([
      "[wake-proxy] no logs available (service has no composeDir or logsCommand)",
      "[wake-proxy] compose directory not found: /missing/dir",
    ]);
  });

  it("follows docker compose logs, buffering partial lines from stdout and stderr", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(),
    });
    const spawn = jest
      .spyOn(childProcess, "spawn")
      .mockReturnValue(child as unknown as childProcess.ChildProcessWithoutNullStreams);
    const lines: string[] = [];
    const stop = streamServiceLogs({ composeDir }, (line) => lines.push(line));

    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["compose", "logs", "-f", "--no-color", "--tail", String(DEFAULT_LOG_TAIL)],
      { cwd: composeDir },
    );
    child.stdout.emit("data", Buffer.from("app | start"));
    child.stdout.emit("data", Buffer.from("ing\napp | ready\n"));
    child.stderr.emit("data", Buffer.from("warn: x\r\n"));
    child.emit("error", new Error("spawn docker ENOENT"));
    expect(lines).toEqual([
      "app | starting",
      "app | ready",
      "warn: x",
      "[wake-proxy] failed to stream logs: spawn docker ENOENT",
    ]);

    stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.stdout.emit("data", Buffer.from("late\n"));
    expect(lines).toHaveLength(4);
  });

  it("honours a custom tail length", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(),
    });
    const spawn = jest
      .spyOn(childProcess, "spawn")
      .mockReturnValue(child as unknown as childProcess.ChildProcessWithoutNullStreams);
    streamServiceLogs({ composeDir }, () => {}, 5)();
    expect(spawn.mock.calls[0][1]).toEqual(["compose", "logs", "-f", "--no-color", "--tail", "5"]);
  });

  it("ends everything the logsCommand shell started when stopped", async () => {
    // A unique duration makes the grandchild `sleep` findable with pgrep
    const duration = `3000.${process.pid}${Date.now() % 100000}`;
    const lines: string[] = [];
    const stop = streamServiceLogs(
      { logsCommand: `echo started; sleep ${duration} & wait` },
      (line) => lines.push(line),
    );
    await waitUntil(() => lines.length === 1);
    const sleeping = () =>
      runFileReal("pgrep", ["-f", `sleep ${duration}`]).then(
        (r) => r.stdout.trim() !== "",
        () => false,
      );
    await waitUntil(sleeping);
    stop();
    await waitUntil(async () => !(await sleeping()));
  });

  it("falls back to killing the child itself when the group is already gone", async () => {
    const stop = streamServiceLogs({ logsCommand: "true" }, () => {});
    await realSleep(50); // the shell has exited; its group no longer exists
    expect(() => stop()).not.toThrow();
  });
});
