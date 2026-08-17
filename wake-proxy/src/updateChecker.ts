import fs from "fs";
import path from "path";
import axios from "axios";

const REPO = "jelliott2021/DockerWakeUp";

// Project root (works for both deployments: systemd runs from the repo,
// docker mounts ./.git at /app/.git)
const rootDir = path.join(__dirname, "../../");

export interface UpdateInfo {
  localCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
}

let info: UpdateInfo = {
  localCommit: null,
  latestCommit: null,
  updateAvailable: false,
  checkedAt: null,
};

export function getUpdateInfo(): UpdateInfo {
  return info;
}

/**
 * Read the current commit SHA from .git without needing the git binary
 * (the docker image doesn't ship one). Returns null when .git is missing,
 * e.g. a tarball download or an unmounted volume.
 */
function getLocalCommit(): { sha: string; branch: string } | null {
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
  } catch { }
  return null;
}

async function checkOnce(): Promise<void> {
  const local = getLocalCommit();
  if (!local) {
    console.warn("Update check: could not read local git commit (is .git present/mounted?). Skipping.");
    return;
  }

  try {
    const res = await axios.get(
      `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(local.branch)}`,
      { timeout: 10_000, headers: { Accept: "application/vnd.github+json" } }
    );
    const latest: string = res.data?.sha;
    if (!latest) return;

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
        `========================================================`
      );
    } else {
      console.log(`Update check: up to date (${local.sha.slice(0, 7)} on ${local.branch})`);
    }
  } catch (e: any) {
    // Offline or rate-limited — not worth alarming anyone over
    console.log(`Update check skipped: ${e?.message ?? e}`);
  }
}

/**
 * Check for updates on startup and then once a day.
 */
export function startUpdateChecker(): void {
  checkOnce();
  setInterval(checkOnce, 24 * 60 * 60 * 1000);
}
