import { exec } from "child_process";
import fs from "fs";
import { getWakeStatus } from "./wakeManager";
import { getLastAccess, touchLastAccess } from "./lastAccess";

interface StoppableService {
  route: string;
  composeDir?: string;
  autoOff?: boolean;
  stopCommand?: string;
}

export function startIdleShutdownChecker(
  services: Record<string, StoppableService>,
  idleThreshold: number
) {
  setInterval(() => {
    Object.values(services).forEach((svc) => {
      // Only stop if autoOff is not false (default true)
      if (svc.autoOff === false) return;

      // Never stop a service that's mid-wake: its timestamp is still old
      // because no request has been proxied successfully yet
      if (getWakeStatus(svc.route).state === "starting") return;

      const lastAccess = getLastAccess(svc.route);
      if (lastAccess === null) {
        // No timestamp yet — start the idle clock now
        touchLastAccess(svc.route);
        return;
      }

      if (Date.now() - lastAccess > idleThreshold * 1000) {
        stopService(svc);
      }
    });
  }, 5 * 60 * 1000); // Check every 5 minutes
}

function stopService(svc: StoppableService) {
  if (!svc.stopCommand && !svc.composeDir) {
    console.error(`Cannot stop idle service ${svc.route}: no composeDir or stopCommand set`);
    return;
  }

  const cwd = svc.composeDir && fs.existsSync(svc.composeDir) ? svc.composeDir : undefined;

  const finish = () => {
    console.log(`Stopped idle service: ${svc.route}`);
    // Reset the timer so the checker doesn't re-run the stop command
    // for this (already stopped) service every 5 minutes
    touchLastAccess(svc.route);
  };

  // Post-stop hook (cleanup/backup/notify/...) runs after docker compose stop
  const runStopHook = () => {
    if (!svc.stopCommand) {
      finish();
      return;
    }
    exec(svc.stopCommand, { cwd }, (err, stdout, stderr) => {
      if (err) {
        console.error(`stopCommand for ${svc.route} failed:`, stderr || err.message);
      }
      // The service itself is stopped either way
      finish();
    });
  };

  if (!svc.composeDir) {
    // stopCommand-only service: the hook is the whole stop
    runStopHook();
    return;
  }
  if (!cwd) {
    console.error(`Cannot stop idle service ${svc.route}: compose directory not found: ${svc.composeDir}`);
    return;
  }
  exec("docker compose stop", { cwd }, (err, stdout, stderr) => {
    if (err) {
      console.error(`Failed to stop service ${svc.route}:`, stderr);
    } else {
      runStopHook();
    }
  });
}
