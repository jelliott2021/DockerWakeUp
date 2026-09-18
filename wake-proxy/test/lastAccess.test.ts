import fs from "fs";
import path from "path";
import {
  HISTORY_LIMIT,
  WRITE_INTERVAL_MS,
  clearLastAccessCache,
  getLastAccess,
  getStateDir,
  getWakeDurations,
  recordWakeDuration,
  touchLastAccess,
} from "../src/lastAccess";
import { mockConsole, useTempStateDir } from "./helpers";

const console = mockConsole();
const stateDir = useTempStateDir();

describe("getStateDir", () => {
  it("uses WAKEUP_STATE_DIR when set", () => {
    expect(getStateDir()).toBe(stateDir());
  });

  it("defaults to ./tmp under the working directory", () => {
    delete process.env.WAKEUP_STATE_DIR;
    expect(getStateDir()).toBe(path.join(process.cwd(), "tmp"));
  });
});

describe("last access timestamps", () => {
  it("persists a touch and reads it back, from memory and from disk", () => {
    touchLastAccess("app", 1000);
    expect(fs.readFileSync(path.join(stateDir(), "last_access_app"), "utf8")).toBe("1000");
    expect(getLastAccess("app")).toBe(1000);
    clearLastAccessCache();
    expect(getLastAccess("app")).toBe(1000);
  });

  it("returns null without a file or with a corrupt one", () => {
    expect(getLastAccess("nothing")).toBeNull();
    fs.writeFileSync(path.join(stateDir(), "last_access_bad"), "not a number");
    expect(getLastAccess("bad")).toBeNull();
  });

  it("throttles disk writes but keeps the in-memory value current", () => {
    touchLastAccess("app", 1000);
    touchLastAccess("app", 1000 + WRITE_INTERVAL_MS - 1);
    expect(getLastAccess("app")).toBe(1000 + WRITE_INTERVAL_MS - 1);
    expect(fs.readFileSync(path.join(stateDir(), "last_access_app"), "utf8")).toBe("1000");

    touchLastAccess("app", 1000 + WRITE_INTERVAL_MS);
    expect(fs.readFileSync(path.join(stateDir(), "last_access_app"), "utf8")).toBe(
      String(1000 + WRITE_INTERVAL_MS),
    );
  });

  it("creates the state directory on demand", () => {
    process.env.WAKEUP_STATE_DIR = path.join(stateDir(), "nested", "deeper");
    touchLastAccess("app", 5);
    expect(getLastAccess("app")).toBe(5);
    expect(fs.existsSync(path.join(stateDir(), "nested", "deeper", "last_access_app"))).toBe(true);
  });

  it("keeps the timestamp in memory when the write fails, and retries next time", () => {
    // A regular file where the directory should be makes mkdir fail
    const blocked = path.join(stateDir(), "blocked");
    fs.writeFileSync(blocked, "");
    process.env.WAKEUP_STATE_DIR = blocked;

    touchLastAccess("app", 1000);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to write last access file for app:",
      expect.anything(),
    );
    expect(getLastAccess("app")).toBe(1000);

    touchLastAccess("app", 1001);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(getLastAccess("app")).toBe(1001);
  });

  it("logs and returns null when the file cannot be read", () => {
    fs.writeFileSync(path.join(stateDir(), "last_access_app"), "1");
    jest.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(getLastAccess("app")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Failed to read last access file for app:",
      expect.any(Error),
    );
  });
});

describe("wake duration history", () => {
  it("appends durations and keeps the most recent HISTORY_LIMIT", () => {
    for (let i = 1; i <= HISTORY_LIMIT + 3; i++) recordWakeDuration("app", i * 1000 + 0.4);
    const durations = getWakeDurations("app");
    expect(durations).toHaveLength(HISTORY_LIMIT);
    expect(durations[0]).toBe(4000);
    expect(durations[HISTORY_LIMIT - 1]).toBe((HISTORY_LIMIT + 3) * 1000);
  });

  it("ignores missing, corrupt or non-numeric history", () => {
    expect(getWakeDurations("none")).toEqual([]);
    const file = path.join(stateDir(), "wake_history_app");
    fs.writeFileSync(file, "{ nope");
    expect(getWakeDurations("app")).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
    expect(getWakeDurations("app")).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([5, "6", -1, 0, null, 7.5, Infinity]));
    expect(getWakeDurations("app")).toEqual([5, 7.5]);
  });

  it("logs when the history cannot be written", () => {
    jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    recordWakeDuration("app", 1);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to record wake duration for app:",
      expect.any(Error),
    );
  });
});
