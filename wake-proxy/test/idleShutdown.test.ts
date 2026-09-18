import fs from "fs";
import * as shell from "../src/shell";
import { CommandError } from "../src/shell";
import * as wakeManager from "../src/wakeManager";
import {
  DEFAULT_CHECK_INTERVAL_MS,
  checkIdleServices,
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
