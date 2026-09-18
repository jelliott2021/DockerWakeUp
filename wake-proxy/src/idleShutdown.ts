/**
 * Idle shutdown: periodically stops services nobody has used for longer than
 * `idleThreshold`. Never stops a service that is mid-wake.
 */
import fs from "fs";
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
}

/** How often idle services are looked for. */
export const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic idle check. Returns the timer, or `null` when idle
 * shutdown is disabled (no positive `idleThreshold` configured).
 */
export function startIdleShutdownChecker(
  services: Record<string, StoppableService>,
  idleThresholdSec: number | undefined,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): NodeJS.Timeout | null {
  if (typeof idleThresholdSec !== "number" || !(idleThresholdSec > 0)) {
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

/** One pass over the services: stop every one idle for longer than the threshold. */
export async function checkIdleServices(
  services: Record<string, StoppableService>,
  idleThresholdSec: number,
  now: number = Date.now(),
): Promise<void> {
  const stops: Promise<void>[] = [];
  for (const svc of Object.values(services)) {
    if (svc.autoOff === false) continue;
    // Its timestamp is still old because no request has been proxied
    // successfully yet — stopping it now would undo the wake
    if (getWakeStatus(svc.route).state === "starting") continue;

    const lastAccess = getLastAccess(svc.route);
    if (lastAccess === null) {
      // No timestamp yet — start the idle clock now
      touchLastAccess(svc.route, now);
      continue;
    }
    if (now - lastAccess > idleThresholdSec * 1000) stops.push(stopService(svc));
  }
  await Promise.all(stops);
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

function stderrOf(e: unknown): string {
  return e instanceof CommandError ? e.stderr : "";
}
