import fs from "fs";
import path from "path";
import axios from "axios";
import {
  CHECK_INTERVAL_MS,
  REPO,
  checkForUpdates,
  getLocalCommit,
  getUpdateInfo,
  resetUpdateInfo,
  startUpdateChecker,
} from "../src/updateChecker";
import { makeTempDir, mockConsole } from "./helpers";

jest.mock("axios");
const get = axios.get as jest.MockedFunction<typeof axios.get>;

const console = mockConsole();
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const EMPTY = { localCommit: null, latestCommit: null, updateAvailable: false, checkedAt: null };

let root: string;
beforeEach(() => {
  root = makeTempDir("repo-");
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  resetUpdateInfo();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  jest.useRealTimers();
});

const writeGit = (file: string, content: string) =>
  fs.writeFileSync(path.join(root, ".git", file), content);

describe("getLocalCommit", () => {
  it("reads a detached HEAD", () => {
    writeGit("HEAD", `${SHA_A}\n`);
    expect(getLocalCommit(root)).toEqual({ sha: SHA_A, branch: "HEAD" });
  });

  it("follows a branch ref to its loose ref file", () => {
    writeGit("HEAD", "ref: refs/heads/main\n");
    writeGit("refs/heads/main", `${SHA_B}\n`);
    expect(getLocalCommit(root)).toEqual({ sha: SHA_B, branch: "main" });
  });

  it("falls back to packed-refs", () => {
    writeGit("HEAD", "ref: refs/heads/feature/x\n");
    writeGit(
      "packed-refs",
      `# pack-refs with: peeled\n${SHA_A} refs/heads/main\n${SHA_B} refs/heads/feature/x\n`,
    );
    expect(getLocalCommit(root)).toEqual({ sha: SHA_B, branch: "feature/x" });
  });

  it("returns null when git metadata is missing or unusable", () => {
    expect(getLocalCommit(path.join(root, "nowhere"))).toBeNull();
    writeGit("HEAD", "garbage\n");
    expect(getLocalCommit(root)).toBeNull();
    writeGit("HEAD", "ref: refs/heads/main\n");
    writeGit("packed-refs", `${SHA_A} refs/heads/other\n`);
    expect(getLocalCommit(root)).toBeNull();
  });

  it("defaults to the project root (a real checkout, or nothing)", () => {
    const local = getLocalCommit();
    if (local) expect(local.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("checkForUpdates", () => {
  beforeEach(() => {
    writeGit("HEAD", "ref: refs/heads/main\n");
    writeGit("refs/heads/main", SHA_A);
  });

  it("skips when the local commit is unknown", async () => {
    expect(await checkForUpdates(path.join(root, "nowhere"))).toEqual(EMPTY);
    expect(get).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "Update check: could not read local git commit (is .git present/mounted?). Skipping.",
    );
  });

  it("reports up to date when GitHub has the same commit", async () => {
    get.mockResolvedValue({ data: { sha: SHA_A } });
    const info = await checkForUpdates(root);
    expect(get).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/commits/main`,
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(info).toEqual({
      localCommit: SHA_A,
      latestCommit: SHA_A,
      updateAvailable: false,
      checkedAt: expect.any(Number),
    });
    expect(console.log).toHaveBeenCalledWith(
      `Update check: up to date (${SHA_A.slice(0, 7)} on main)`,
    );
  });

  it("warns with a banner when a newer commit exists", async () => {
    get.mockResolvedValue({ data: { sha: SHA_B } });
    const info = await checkForUpdates(root);
    expect(info.updateAvailable).toBe(true);
    expect(getUpdateInfo()).toBe(info);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("A newer version of DockerWakeUp is available!"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`latest: ${SHA_B.slice(0, 7)} (main)`),
    );
  });

  it("url-encodes branch names", async () => {
    writeGit("HEAD", "ref: refs/heads/feature/x\n");
    fs.mkdirSync(path.join(root, ".git", "refs", "heads", "feature"));
    writeGit("refs/heads/feature/x", SHA_A);
    get.mockResolvedValue({ data: { sha: SHA_A } });
    await checkForUpdates(root);
    expect(get.mock.calls[0][0]).toBe(`https://api.github.com/repos/${REPO}/commits/feature%2Fx`);
  });

  it("defaults to the project root", async () => {
    // A real checkout is compared against GitHub (and is up to date, since the
    // mocked answer is its own commit); a tarball logs the warning instead
    get.mockResolvedValue({ data: { sha: getLocalCommit()?.sha ?? SHA_A } });
    await checkForUpdates();
    expect(get.mock.calls.length + console.warn.mock.calls.length).toBe(1);
  });

  it("leaves the previous result alone when GitHub returns no sha", async () => {
    get.mockResolvedValue({ data: {} });
    expect(await checkForUpdates(root)).toEqual(EMPTY);
  });

  it("logs and carries on when the request fails", async () => {
    get.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com"));
    await checkForUpdates(root);
    expect(console.log).toHaveBeenCalledWith(
      "Update check skipped: getaddrinfo ENOTFOUND api.github.com",
    );
    expect(getUpdateInfo()).toEqual(EMPTY);
  });
});

describe("startUpdateChecker", () => {
  it("checks immediately and then on the interval, without keeping the process alive", async () => {
    jest.useFakeTimers();
    writeGit("HEAD", SHA_A);
    get.mockResolvedValue({ data: { sha: SHA_A } });
    const timer = startUpdateChecker(root);
    expect(timer.hasRef()).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(get).toHaveBeenCalledTimes(2);
    clearInterval(timer);

    clearInterval(startUpdateChecker()); // defaults: project root, daily
    const calls = get.mock.calls.length; // 3 with a real checkout, 2 without
    const custom = startUpdateChecker(root, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(get).toHaveBeenCalledTimes(calls + 2);
    clearInterval(custom);
  });
});
