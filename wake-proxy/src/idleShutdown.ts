import { exec } from "child_process";
import fs from "fs";
import path from "path";

// tmp folder inside the service's working directory
const tmpDir = path.join(process.cwd(), "tmp");

// create the tmp folder if it doesn't exist
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

export function startIdleShutdownChecker(
  services: Record<string, { route: string; composeDir: string }>,
  idleThreshold: number
) {
  setInterval(() => {
    Object.values(services).forEach((svc) => {
      const lastFile = path.join(tmpDir, `last_access_${svc.route}`);
      const lastAccess = getLastAccessTime(lastFile);
      const now = Date.now();
      const idleTime = now - lastAccess;

      if (idleTime > idleThreshold * 1000) {
        stopService(svc.route, svc.composeDir);
      }
    });
  }, 5 * 60 * 1000); // Check every 5 minutes
}

function getLastAccessTime(lastFile: string): number {
  if (fs.existsSync(lastFile)) {
    try {
      return parseInt(fs.readFileSync(lastFile, "utf8"), 10);
    } catch (error) {
      console.error(`Failed to read last access file ${lastFile}:`, error);
    }
  }
  // If no last access file exists, consider service as just started
  return Date.now();
}

function stopService(serviceName: string, composeDir: string) {
  const cmd = "docker compose stop";
  
  exec(cmd, { cwd: composeDir }, (err, stdout, stderr) => {
    if (err) {
      console.error(`Failed to stop service ${serviceName}:`, stderr);
    } else {
      console.log(`Stopped idle service: ${serviceName}`);
    }
  });
}
