/**
 * Per-service state on disk: last-access timestamps (idle shutdown) and wake
 * duration history (the "usually ready in ~Xs" estimate).
 *
 * Files live in `$WAKEUP_STATE_DIR`, or `./tmp` under the working directory
 * (`wake-proxy/tmp/` for the documented deployments). Deleting them is safe.
 */
import fs from "fs";
import path from "path";

/** Persist a last-access timestamp at most this often per service. */
export const WRITE_INTERVAL_MS = 10_000;
/** Number of wake durations kept per service. */
export const HISTORY_LIMIT = 10;

interface CachedAccess {
  value: number;
  /** When the value was last written to disk; `null` when every write so far failed */
  persistedAt: number | null;
}

// In-memory copy of the timestamps. Busy services (media streaming, polling
// dashboards) produce many successful responses per second, and each one used
// to be a synchronous file write; now only the first touch per interval hits
// the disk. Idle thresholds are minutes to days, so the precision lost on a
// restart (at most WRITE_INTERVAL_MS) is irrelevant.
const cache = new Map<string, CachedAccess>();

/** Directory holding the marker files. */
export function getStateDir(): string {
  const configured = process.env.WAKEUP_STATE_DIR;
  return configured ? path.resolve(configured) : path.join(process.cwd(), "tmp");
}

function lastAccessFile(route: string): string {
  return path.join(getStateDir(), `last_access_${route}`);
}

function historyFile(route: string): string {
  return path.join(getStateDir(), `wake_history_${route}`);
}

/** Record activity for a service. */
export function touchLastAccess(route: string, now: number = Date.now()): void {
  const cached = cache.get(route);
  if (
    cached?.persistedAt !== null &&
    cached !== undefined &&
    now - cached.persistedAt < WRITE_INTERVAL_MS
  ) {
    cached.value = now;
    return;
  }
  try {
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(lastAccessFile(route), String(now));
    cache.set(route, { value: now, persistedAt: now });
  } catch (e) {
    console.error(`Failed to write last access file for ${route}:`, e);
    // Keep the timestamp in memory anyway; the next touch retries the write
    cache.set(route, { value: now, persistedAt: cached?.persistedAt ?? null });
  }
}

/** Last recorded activity for a service (epoch ms), or `null` when unknown. */
export function getLastAccess(route: string): number | null {
  const cached = cache.get(route);
  if (cached) return cached.value;
  try {
    if (!fs.existsSync(lastAccessFile(route))) return null;
    const value = parseInt(fs.readFileSync(lastAccessFile(route), "utf8"), 10);
    return Number.isFinite(value) ? value : null;
  } catch (e) {
    console.error(`Failed to read last access file for ${route}:`, e);
    return null;
  }
}

/** Forget the in-memory timestamps (tests, or after editing the state dir by hand). */
export function clearLastAccessCache(): void {
  cache.clear();
}

/** Append a wake duration to the service's history, keeping the last HISTORY_LIMIT entries. */
export function recordWakeDuration(route: string, durationMs: number): void {
  try {
    fs.mkdirSync(getStateDir(), { recursive: true });
    const durations = getWakeDurations(route);
    durations.push(Math.round(durationMs));
    fs.writeFileSync(historyFile(route), JSON.stringify(durations.slice(-HISTORY_LIMIT)));
  } catch (e) {
    console.error(`Failed to record wake duration for ${route}:`, e);
  }
}

/** Recorded wake durations (ms) for a service, oldest first; unreadable history counts as empty. */
export function getWakeDurations(route: string): number[] {
  try {
    if (!fs.existsSync(historyFile(route))) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(historyFile(route), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0)
      : [];
  } catch {
    return [];
  }
}
