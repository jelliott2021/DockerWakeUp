/**
 * Idle shutdown: periodically stops services nobody has used for longer than
 * their `idleThreshold` (per service, or the global one). Activity the proxy
 * cannot see itself comes from a service's `activityCommand`. Services that
 * share a compose stack are stopped together. Never stops a service that is
 * mid-wake.
 */
import fs from "fs";
import path from "path";
import { getWakeStatus } from "./wakeManager";
import { getLastAccess, touchLastAccess } from "./lastAccess";
import { CommandError, runShell } from "./shell";
import { errorMessage } from "./util";

/** The parts of a service config idle shutdown needs. */
export interface StoppableService {
  route: string;
  composeDir?: string;
  autoOff?: boolean;
  /** Post-stop hook run after `docker compose stop`, or the whole stop when there is no composeDir */
  stopCommand?: string;
  /** Overrides the global threshold for this service (seconds) */
  idleThreshold?: number;
  /** Prints Unix timestamps (seconds) of activity the proxy can't see; the newest counts */
  activityCommand?: string;
}

/** How often idle services are looked for. */
export const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic idle check. Returns the timer, or `null` when idle
 * shutdown is disabled (no positive `idleThreshold`, global or per service).
 */
export function startIdleShutdownChecker(
  services: Record<string, StoppableService>,
  idleThresholdSec: number | undefined,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): NodeJS.Timeout | null {
  const enabled =
    positive(idleThresholdSec) !== undefined ||
    Object.values(services).some((svc) => positive(svc.idleThreshold) !== undefined);
  if (!enabled) {
    console.log("Idle shutdown disabled (no idleThreshold in config.json)");
    return null;
  }
  const timer = setInterval(() => {
    void checkIdleServices(services, idleThresholdSec);
  }, intervalMs);
  // The HTTP server keeps the process alive; this timer alone should not
  timer.unref();
  return timer;
}

/**
 * One pass over the services: stop every one idle for longer than its
 * threshold. Services sharing a compose stack (same `composeDir`, e.g. a web
 * UI and a UDP port of one container) are stopped together, and only once
 * every one of them is idle.
 */
export async function checkIdleServices(
  services: Record<string, StoppableService>,
  idleThresholdSec: number | undefined,
  now: number = Date.now(),
): Promise<void> {
  const all = Object.values(services);
  const idle = new Set<StoppableService>();
  await Promise.all(
    all.map(async (svc) => {
      if (await isIdle(svc, idleThresholdSec, now)) idle.add(svc);
    }),
  );

  const stacks = new Map<string, StoppableService[]>();
  for (const svc of all) {
    const key = svc.composeDir ? path.resolve(svc.composeDir) : `route:${svc.route}`;
    stacks.set(key, [...(stacks.get(key) ?? []), svc]);
  }
  await Promise.all(
    [...stacks.values()].map(async (members) => {
      if (!members.every((svc) => idle.has(svc))) return;
      // One after another: the first stops the stack, the rest only run their hooks
      for (const svc of members) await stopService(svc);
    }),
  );
}

/** Whether a service has been idle for longer than its threshold (starts its idle clock if unset). */
async function isIdle(
  svc: StoppableService,
  defaultThresholdSec: number | undefined,
  now: number,
): Promise<boolean> {
  if (svc.autoOff === false) return false;
  const thresholdSec = positive(svc.idleThreshold) ?? positive(defaultThresholdSec);
  if (thresholdSec === undefined) return false;
  // Its timestamp is still old because no request has been proxied
  // successfully yet — stopping it now would undo the wake
  if (getWakeStatus(svc.route).state === "starting") return false;

  const lastAccess = getLastAccess(svc.route);
  if (lastAccess === null) {
    // No timestamp yet — start the idle clock now
    touchLastAccess(svc.route, now);
    return false;
  }
  const limitMs = thresholdSec * 1000;
  if (now - lastAccess <= limitMs) return false;

  // Only asked once the proxy's own clock says idle, so a busy service's
  // command doesn't run on every pass
  if (svc.activityCommand) {
    const activity = await lastActivity(svc, svc.activityCommand);
    if (activity !== null && now - activity <= limitMs) {
      touchLastAccess(svc.route, activity);
      return false;
    }
  }
  return true;
}

/**
 * Newest Unix timestamp in a command's output (whitespace-separated tokens
 * that are all digits, so `wg show wg0 latest-handshakes` works as is).
 * Seconds are converted to milliseconds; zeros ("never") are ignored.
 */
export function parseActivityTimestamp(output: string): number | null {
  const stamps = output
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token))
    .map(Number)
    .filter((n) => n > 0);
  if (stamps.length === 0) return null;
  const newest = Math.max(...stamps);
  // Anything this small is seconds; millisecond timestamps pass through
  return newest < 1e11 ? newest * 1000 : newest;
}

/** Run a service's activityCommand; `null` when it fails or prints no timestamp. */
async function lastActivity(svc: StoppableService, command: string): Promise<number | null> {
  const cwd = svc.composeDir && fs.existsSync(svc.composeDir) ? svc.composeDir : undefined;
  try {
    const { stdout } = await runShell(command, cwd);
    return parseActivityTimestamp(stdout);
  } catch (e) {
    // Usually the service is already stopped; counts as no activity
    console.log(
      `activityCommand for ${svc.route} failed (treating as idle):`,
      stderrOf(e) || errorMessage(e),
    );
    return null;
  }
}

/**
 * Stop one service: `docker compose stop` in its compose directory (when it
 * has one), then the `stopCommand` hook. Errors are logged, never thrown.
 */
export async function stopService(svc: StoppableService): Promise<void> {
  if (!svc.stopCommand && !svc.composeDir) {
    console.error(`Cannot stop idle service ${svc.route}: no composeDir or stopCommand set`);
    return;
  }
  const cwd = svc.composeDir && fs.existsSync(svc.composeDir) ? svc.composeDir : undefined;

  if (svc.composeDir) {
    if (!cwd) {
      console.error(
        `Cannot stop idle service ${svc.route}: compose directory not found: ${svc.composeDir}`,
      );
      return;
    }
    try {
      await runShell("docker compose stop", cwd);
    } catch (e) {
      console.error(`Failed to stop service ${svc.route}:`, stderrOf(e));
      return;
    }
  }

  if (svc.stopCommand) {
    try {
      await runShell(svc.stopCommand, cwd);
    } catch (e) {
      // The service itself is stopped either way
      console.error(`stopCommand for ${svc.route} failed:`, stderrOf(e) || errorMessage(e));
    }
  }

  console.log(`Stopped idle service: ${svc.route}`);
  // Reset the timer so the checker doesn't re-run the stop for this
  // (already stopped) service on every pass
  touchLastAccess(svc.route);
}

/** The value when it is a positive number, otherwise `undefined`. */
function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function stderrOf(e: unknown): string {
  return e instanceof CommandError ? e.stderr : "";
}
