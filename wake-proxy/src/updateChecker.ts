/**
 * Daily check whether a newer DockerWakeUp commit exists on GitHub. Purely
 * informational: logs a banner and reports on /healthz.
 */
import fs from "fs";
import path from "path";
import axios from "axios";
import { PROJECT_ROOT } from "./config";
import { errorMessage } from "./util";

export const REPO = "jelliott2021/DockerWakeUp";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  localCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
}

export interface LocalCommit {
  sha: string;
  branch: string;
}

const EMPTY: UpdateInfo = {
  localCommit: null,
  latestCommit: null,
  updateAvailable: false,
  checkedAt: null,
};
let info: UpdateInfo = { ...EMPTY };

/** Result of the most recent check. */
export function getUpdateInfo(): UpdateInfo {
  return info;
}

/** Forget the last result (tests). */
export function resetUpdateInfo(): void {
  info = { ...EMPTY };
}

/**
 * Read the current commit SHA from `.git` without needing the git binary (the
 * docker image doesn't ship one). Returns `null` when `.git` is missing, e.g.
 * a tarball download or an unmounted volume.
 */
export function getLocalCommit(rootDir: string = PROJECT_ROOT): LocalCommit | null {
  try {
    const head = fs.readFileSync(path.join(rootDir, ".git/HEAD"), "utf8").trim();

    // Detached HEAD: the file holds the SHA directly
    if (/^[0-9a-f]{40}$/.test(head)) return { sha: head, branch: "HEAD" };

    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) return null;
    const ref = refMatch[1];
    const branch = ref.replace(/^refs\/heads\//, "");

    const refFile = path.join(rootDir, ".git", ref);
    if (fs.existsSync(refFile)) {
      return { sha: fs.readFileSync(refFile, "utf8").trim(), branch };
    }

    // Ref may only exist in packed-refs
    const packed = fs.readFileSync(path.join(rootDir, ".git/packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, packedRef] = line.split(" ");
      if (packedRef === ref && sha) return { sha, branch };
    }
  } catch {
    // fall through: no usable git metadata
  }
  return null;
}

/** Compare the local commit with the branch head on GitHub and log the outcome. */
export async function checkForUpdates(rootDir: string = PROJECT_ROOT): Promise<UpdateInfo> {
  const local = getLocalCommit(rootDir);
  if (!local) {
    console.warn(
      "Update check: could not read local git commit (is .git present/mounted?). Skipping.",
    );
    return info;
  }

  try {
    const res = await axios.get<{ sha?: string }>(
      `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(local.branch)}`,
      { timeout: 10_000, headers: { Accept: "application/vnd.github+json" } },
    );
    const latest = res.data?.sha;
    if (!latest) return info;

    info = {
      localCommit: local.sha,
      latestCommit: latest,
      updateAvailable: latest !== local.sha,
      checkedAt: Date.now(),
    };

    if (info.updateAvailable) {
      console.warn(
        `\n========================================================\n` +
          `  A newer version of DockerWakeUp is available!\n` +
          `  local:  ${local.sha.slice(0, 7)}\n` +
          `  latest: ${latest.slice(0, 7)} (${local.branch})\n` +
          `  To update:\n` +
          `    git pull\n` +
          `    docker compose up -d --build   # docker deployment\n` +
          `    ./setup-service.sh             # systemd deployment\n` +
          `========================================================`,
      );
    } else {
      console.log(`Update check: up to date (${local.sha.slice(0, 7)} on ${local.branch})`);
    }
  } catch (e) {
    // Offline or rate-limited — not worth alarming anyone over
    console.log(`Update check skipped: ${errorMessage(e)}`);
  }
  return info;
}

/** Check on startup and then once a day. Returns the interval timer. */
export function startUpdateChecker(
  rootDir: string = PROJECT_ROOT,
  intervalMs: number = CHECK_INTERVAL_MS,
): NodeJS.Timeout {
  void checkForUpdates(rootDir);
  const timer = setInterval(() => void checkForUpdates(rootDir), intervalMs);
  timer.unref();
  return timer;
}
