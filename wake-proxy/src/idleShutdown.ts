import { exec } from "child_process";
import fs from "fs";
import path from 'path';

// tmp folder inside the service's working directory
const tmpDir = path.join(process.cwd(), "tmp");

// create the tmp folder if it doesn't exist
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

export function startIdleShutdownChecker(services: Record<string, { route: string; composeDir: string }>, idleThreshold: number) {
  setInterval(() => {
    Object.values(services).forEach((svc) => {
      const lastFile = path.join(tmpDir, `last_access_${svc.route}`);
      let lastAccess: number;
      if (fs.existsSync(lastFile)) {
        lastAccess = parseInt(fs.readFileSync(lastFile, "utf8"), 10);
      } else {
        // If no last access file, use container start time
        lastAccess = getContainerStartedAt(svc.route);
      }
      const now = Date.now();
      const idleTime = now - lastAccess;
      if (idleTime > idleThreshold * 1000) {
        stopContainer(svc.route);
      }
    });
  }, 5 * 60 * 1000); // 5 minutes
}

function getContainerStartedAt(containerName: string): number {
  // Get startedAt from docker inspect
  try {
    const cmd = `docker inspect -f '{{.State.StartedAt}}' ${containerName}`;
    const startedAtStr = require("child_process").execSync(cmd).toString().trim();
    const startedAt = new Date(startedAtStr).getTime();
    return startedAt || Date.now();
  } catch {
    return Date.now();
  }
}

function stopContainer(containerName: string) {
  const cmd = `docker stop ${containerName}`;
  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`Failed to stop container ${containerName}:`, stderr);
    } else {
      console.log(`Stopped idle container: ${containerName}`);
    }
  });
}
