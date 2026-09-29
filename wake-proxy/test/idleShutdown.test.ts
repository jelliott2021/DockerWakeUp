import fs from "fs";
import * as shell from "../src/shell";
import { CommandError } from "../src/shell";
import * as wakeManager from "../src/wakeManager";
import {
  DEFAULT_CHECK_INTERVAL_MS,
  checkIdleServices,
  parseActivityTimestamp,
  startIdleShutdownChecker,
  stopService,
} from "../src/idleShutdown";
import { getLastAccess, touchLastAccess } from "../src/lastAccess";
import { makeTempDir, mockConsole, useTempStateDir } from "./helpers";

jest.mock("../src/shell", () => ({
  ...jest.requireActual("../src/shell"),
  runShell: jest.fn(),
}));
jest.mock("../src/wakeManager", () => ({ getWakeStatus: jest.fn() }));
const runShell = shell.runShell as jest.MockedFunction<typeof shell.runShell>;
const getWakeStatus = wakeManager.getWakeStatus as jest.MockedFunction<
  typeof wakeManager.getWakeStatus
>;
const ok = { stdout: "", stderr: "" };

const console = mockConsole();
useTempStateDir();

let composeDir: string;
beforeEach(() => {
  composeDir = makeTempDir("compose-");
  getWakeStatus.mockReturnValue({ state: "idle" });
  runShell.mockResolvedValue(ok);
});
afterEach(() => {
  fs.rmSync(composeDir, { recursive: true, force: true });
  jest.useRealTimers();
});

describe("startIdleShutdownChecker", () => {
  it("is disabled without a positive idleThreshold", () => {
    for (const threshold of [undefined, 0, -5, NaN, "3" as unknown as number]) {
      expect(startIdleShutdownChecker({}, threshold)).toBeNull();
    }
    expect(console.log).toHaveBeenCalledTimes(5);
    expect(console.log).toHaveBeenCalledWith(
      "Idle shutdown disabled (no idleThreshold in config.json)",
    );
  });

  it("checks on an interval that does not keep the process alive", async () => {
    jest.useFakeTimers();
    const services = { app: { route: "app", composeDir } };
    touchLastAccess("app", Date.now() - 20_000);
    const timer = startIdleShutdownChecker(services, 10);
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
    expect(runShell).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(runShell).toHaveBeenCalledWith("docker compose stop", composeDir);
    clearInterval(timer!);
  });

  it("is enabled by a per-service threshold alone", async () => {
    jest.useFakeTimers();
    touchLastAccess("vpn", Date.now() - 20_000);
    const timer = startIdleShutdownChecker(
      { vpn: { route: "vpn", composeDir, idleThreshold: 10 } },
      undefined,
      1000,
    );
    expect(timer).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1000);
    expect(runShell).toHaveBeenCalledWith("docker compose stop", composeDir);
    clearInterval(timer!);
  });

  it("accepts a custom interval", async () => {
    jest.useFakeTimers();
    touchLastAccess("app", Date.now() - 20_000);
    const timer = startIdleShutdownChecker({ app: { route: "app", composeDir } }, 10, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(runShell).toHaveBeenCalledTimes(1);
    clearInterval(timer!);
  });
});

describe("checkIdleServices", () => {
  const now = 1_000_000_000;

  it("skips services exempt from idle shutdown", async () => {
    touchLastAccess("keep", now - 1_000_000);
    await checkIdleServices({ keep: { route: "keep", composeDir, autoOff: false } }, 10, now);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("never stops a service that is mid-wake", async () => {
    getWakeStatus.mockReturnValue({ state: "starting", startedAt: now });
    touchLastAccess("app", now - 1_000_000);
    await checkIdleServices({ app: { route: "app", composeDir } }, 10, now);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("starts the idle clock for services without a timestamp", async () => {
    await checkIdleServices({ app: { route: "app", composeDir } }, 10, now);
    expect(getLastAccess("app")).toBe(now);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("stops only the services idle for longer than the threshold", async () => {
    touchLastAccess("fresh", now - 9_000);
    touchLastAccess("stale", now - 11_000);
    const staleDir = makeTempDir("stale-");
    await checkIdleServices(
      { fresh: { route: "fresh", composeDir }, stale: { route: "stale", composeDir: staleDir } },
      10,
      now,
    );
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenCalledWith("docker compose stop", staleDir);
    expect(console.log).toHaveBeenCalledWith("Stopped idle service: stale");
    fs.rmSync(staleDir, { recursive: true, force: true });
  });

  it("uses a service's own idleThreshold over the global one", async () => {
    const longDir = makeTempDir("long-");
    touchLastAccess("short", now - 60_000);
    touchLastAccess("long", now - 60_000);
    touchLastAccess("none", now - 60_000);
    await checkIdleServices(
      {
        short: { route: "short", composeDir, idleThreshold: 30 },
        long: { route: "long", composeDir: longDir, idleThreshold: 3600 },
      },
      10,
      now,
    );
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("Stopped idle service: short");
    fs.rmSync(longDir, { recursive: true, force: true });

    // No threshold anywhere: never stopped
    await checkIdleServices({ none: { route: "none", composeDir } }, undefined, now);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("stops services without a composeDir on their own", async () => {
    touchLastAccess("a", now - 60_000);
    touchLastAccess("b", now - 60_000);
    await checkIdleServices(
      {
        a: { route: "a", stopCommand: "pkill -f a" },
        b: { route: "b", stopCommand: "pkill -f b" },
      },
      10,
      now,
    );
    expect(runShell).toHaveBeenCalledWith("pkill -f a", undefined);
    expect(runShell).toHaveBeenCalledWith("pkill -f b", undefined);
  });

  describe("services sharing a compose stack", () => {
    // A web UI and a UDP port of the same container
    const stack = (extra: object = {}) => ({
      ui: { route: "ui", composeDir, ...extra },
      tunnel: { route: "tunnel", composeDir: `${composeDir}/`, ...extra },
    });

    it("keep the stack up while any of them is in use", async () => {
      touchLastAccess("ui", now - 60_000);
      touchLastAccess("tunnel", now - 1_000);
      await checkIdleServices(stack(), 10, now);
      expect(runShell).not.toHaveBeenCalled();
    });

    it("keep the stack up when one of them is exempt or has no threshold", async () => {
      touchLastAccess("ui", now - 60_000);
      touchLastAccess("tunnel", now - 60_000);
      const services = stack();
      await checkIdleServices(
        { ...services, tunnel: { ...services.tunnel, autoOff: false } },
        10,
        now,
      );
      await checkIdleServices(
        { ...services, ui: { ...services.ui, idleThreshold: 10 } },
        undefined,
        now,
      );
      expect(runShell).not.toHaveBeenCalled();
    });

    it("stop together, one after another, once all are idle", async () => {
      touchLastAccess("ui", now - 60_000);
      touchLastAccess("tunnel", now - 60_000);
      let running = 0;
      let overlapped = false;
      runShell.mockImplementation(async () => {
        running++;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        return ok;
      });
      await checkIdleServices(stack(), 10, now);
      expect(runShell).toHaveBeenCalledTimes(2);
      expect(overlapped).toBe(false);
      expect(console.log).toHaveBeenCalledWith("Stopped idle service: ui");
      expect(console.log).toHaveBeenCalledWith("Stopped idle service: tunnel");
    });
  });

  describe("with an activityCommand", () => {
    const vpn = () => ({
      route: "vpn",
      composeDir,
      activityCommand: "wg show wg0 latest-handshakes",
    });
    const nowSec = now / 1000;

    it("is not asked while the proxy's own clock says the service is in use", async () => {
      touchLastAccess("vpn", now - 5_000);
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(runShell).not.toHaveBeenCalled();
    });

    it("keeps a service with recent activity and moves its idle clock", async () => {
      touchLastAccess("vpn", now - 60_000);
      runShell.mockResolvedValueOnce({
        stdout: `peerA=\t${nowSec - 100}\npeerB=\t${nowSec - 5}\n`,
        stderr: "",
      });
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(runShell).toHaveBeenCalledTimes(1);
      expect(runShell).toHaveBeenCalledWith("wg show wg0 latest-handshakes", composeDir);
      expect(getLastAccess("vpn")).toBe(now - 5_000);
    });

    it("stops a service whose last activity is too old or unknown", async () => {
      touchLastAccess("vpn", now - 60_000);
      runShell.mockResolvedValueOnce({ stdout: `peerA=\t${nowSec - 100}\n`, stderr: "" });
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(runShell).toHaveBeenLastCalledWith("docker compose stop", composeDir);

      runShell.mockClear();
      touchLastAccess("vpn", now - 60_000);
      runShell.mockResolvedValueOnce({ stdout: "peerA=\t0\n", stderr: "" });
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(runShell).toHaveBeenLastCalledWith("docker compose stop", composeDir);
    });

    it("treats a failing command as no activity", async () => {
      touchLastAccess("vpn", now - 60_000);
      runShell.mockRejectedValueOnce(new CommandError("failed", "No such container\n"));
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(console.log).toHaveBeenCalledWith(
        "activityCommand for vpn failed (treating as idle):",
        "No such container\n",
      );
      expect(runShell).toHaveBeenLastCalledWith("docker compose stop", composeDir);

      touchLastAccess("vpn", now - 60_000);
      runShell.mockRejectedValueOnce(new Error("spawn failed"));
      await checkIdleServices({ vpn: vpn() }, 10, now);
      expect(console.log).toHaveBeenCalledWith(
        "activityCommand for vpn failed (treating as idle):",
        "spawn failed",
      );
    });

    it("runs outside the compose directory when it is missing", async () => {
      touchLastAccess("gone", now - 60_000);
      runShell.mockResolvedValueOnce({ stdout: String(nowSec), stderr: "" });
      await checkIdleServices(
        { gone: { route: "gone", composeDir: "/gone", activityCommand: "date +%s" } },
        10,
        now,
      );
      expect(runShell).toHaveBeenCalledWith("date +%s", undefined);
      expect(runShell).toHaveBeenCalledTimes(1);
    });
  });
});

describe("stopService", () => {
  it("refuses services with nothing to run", async () => {
    await stopService({ route: "app" });
    expect(console.error).toHaveBeenCalledWith(
      "Cannot stop idle service app: no composeDir or stopCommand set",
    );
    expect(runShell).not.toHaveBeenCalled();
  });

  it("refuses when the compose directory is missing", async () => {
    await stopService({ route: "app", composeDir: "/gone", stopCommand: "echo" });
    expect(console.error).toHaveBeenCalledWith(
      "Cannot stop idle service app: compose directory not found: /gone",
    );
    expect(runShell).not.toHaveBeenCalled();
  });

  it("stops via docker compose and resets the idle timer", async () => {
    await stopService({ route: "app", composeDir });
    expect(runShell).toHaveBeenCalledWith("docker compose stop", composeDir);
    expect(console.log).toHaveBeenCalledWith("Stopped idle service: app");
    expect(getLastAccess("app")).not.toBeNull();
  });

  it("gives up (no hook, no timer reset) when docker compose stop fails", async () => {
    runShell.mockRejectedValue(new CommandError("Command failed", "daemon down\n"));
    await stopService({ route: "app", composeDir, stopCommand: "./backup.sh" });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Failed to stop service app:", "daemon down\n");
    expect(console.log).not.toHaveBeenCalled();
    expect(getLastAccess("app")).toBeNull();
  });

  it("runs the stop hook after docker compose stop and tolerates its failure", async () => {
    runShell
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new CommandError("Command failed: ./backup.sh", "disk full\n"));
    await stopService({ route: "app", composeDir, stopCommand: "./backup.sh" });
    expect(runShell).toHaveBeenNthCalledWith(2, "./backup.sh", composeDir);
    expect(console.error).toHaveBeenCalledWith("stopCommand for app failed:", "disk full\n");
    expect(console.log).toHaveBeenCalledWith("Stopped idle service: app");
  });

  it("uses the error message when a failing hook printed nothing", async () => {
    runShell.mockResolvedValueOnce(ok).mockRejectedValueOnce(new Error("killed"));
    await stopService({ route: "app", composeDir, stopCommand: "./backup.sh" });
    expect(console.error).toHaveBeenCalledWith("stopCommand for app failed:", "killed");
  });

  it("treats the hook as the whole stop for services without a composeDir", async () => {
    await stopService({ route: "app", stopCommand: "pkill -f server" });
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenCalledWith("pkill -f server", undefined);
    expect(console.log).toHaveBeenCalledWith("Stopped idle service: app");
  });
});

describe("parseActivityTimestamp", () => {
  it("returns the newest timestamp in milliseconds", () => {
    expect(parseActivityTimestamp("a=\t1790000000\nb=\t1790000100\n")).toBe(1_790_000_100_000);
    expect(parseActivityTimestamp("1790000000123")).toBe(1_790_000_000_123);
  });

  it("ignores zeros and anything that is not a plain number", () => {
    expect(parseActivityTimestamp("peer\t0\n")).toBeNull();
    expect(parseActivityTimestamp("")).toBeNull();
    expect(parseActivityTimestamp("never 12.5 -3 1e9")).toBeNull();
  });
});
