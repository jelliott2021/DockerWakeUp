import fs from "fs";
import path from "path";

// tmp folder inside the service's working directory
const tmpDir = path.join(process.cwd(), "tmp");

// create the tmp folder if it doesn't exist
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function fileFor(route: string): string {
  return path.join(tmpDir, `last_access_${route}`);
}

export function touchLastAccess(route: string): void {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(fileFor(route), Date.now().toString());
  } catch (e) {
    console.error(`Failed to write last access file for ${route}:`, e);
  }
}

export function getLastAccess(route: string): number | null {
  try {
    if (!fs.existsSync(fileFor(route))) return null;
    const value = parseInt(fs.readFileSync(fileFor(route), "utf8"), 10);
    return Number.isFinite(value) ? value : null;
  } catch (e) {
    console.error(`Failed to read last access file for ${route}:`, e);
    return null;
  }
}

// --- Wake duration history (used for the "usually ready in ~Xs" estimate) ---

const HISTORY_LIMIT = 10;

function historyFileFor(route: string): string {
  return path.join(tmpDir, `wake_history_${route}`);
}

export function recordWakeDuration(route: string, durationMs: number): void {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const durations = getWakeDurations(route);
    durations.push(Math.round(durationMs));
    fs.writeFileSync(historyFileFor(route), JSON.stringify(durations.slice(-HISTORY_LIMIT)));
  } catch (e) {
    console.error(`Failed to record wake duration for ${route}:`, e);
  }
}

export function getWakeDurations(route: string): number[] {
  try {
    if (!fs.existsSync(historyFileFor(route))) return [];
    const arr = JSON.parse(fs.readFileSync(historyFileFor(route), "utf8"));
    return Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n) && n > 0) : [];
  } catch {
    return [];
  }
}
