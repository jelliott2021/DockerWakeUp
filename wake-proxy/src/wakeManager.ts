import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";

export type WakeState = "idle" | "starting" | "ready" | "failed";

export interface WakeStatus {
  state: WakeState;
  startedAt?: number;
  error?: string;
}

const statuses: Record<string, WakeStatus> = {};

// Don't retry a failed wake-up for this long
const FAILED_RETRY_MS = 15_000;

export function getWakeStatus(route: string): WakeStatus {
  return statuses[route] ?? { state: "idle" };
}

/**
 * Kick off a wake-up for a service (fire-and-forget).
 * Deduped: if a wake-up is already in progress, or one just failed, this is a no-op.
 */
export function triggerWake(
  route: string,
  composeDir: string,
  target: string,
  timeoutMs: number = 120_000
): void {
  const current = statuses[route];
  if (current?.state === "starting") return;
  if (current?.state === "failed" && Date.now() - (current.startedAt ?? 0) < FAILED_RETRY_MS) return;

  // A missing cwd makes spawn fail with a misleading "spawn /bin/sh ENOENT"
  if (!fs.existsSync(composeDir)) {
    const msg = `Compose directory not found: ${composeDir} — check this service's composeDir in config.json`;
    statuses[route] = { state: "failed", startedAt: Date.now(), error: msg };
    console.error(`Failed to wake service ${route}: ${msg}`);
    return;
  }

  const startedAt = Date.now();
  statuses[route] = { state: "starting", startedAt };

  (async () => {
    try {
      await bringUpService(composeDir);
      await waitForHttpReady(target, timeoutMs);
      statuses[route] = { state: "ready", startedAt };
      console.log(`Service ${route} is ready (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      statuses[route] = { state: "failed", startedAt: Date.now(), error: e?.message ?? String(e) };
      console.error(`Failed to wake service ${route}:`, e);
    }
  })();
}

/**
 * Stream `docker compose logs -f` for a compose project, line by line.
 * Returns a function that stops the stream.
 */
export function streamComposeLogs(
  composeDir: string,
  onLine: (line: string) => void,
  tail: number = 50
): () => void {
  if (!fs.existsSync(composeDir)) {
    onLine(`[wake-proxy] compose directory not found: ${composeDir}`);
    return () => { };
  }

  const child = spawn(
    "docker",
    ["compose", "logs", "-f", "--no-color", "--tail", String(tail)],
    { cwd: composeDir, env: process.env }
  );

  let buffer = "";
  const handleChunk = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach((line) => {
      if (line.trim().length > 0) onLine(line);
    });
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("error", (err) => onLine(`[wake-proxy] failed to stream logs: ${err.message}`));

  return () => {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.kill("SIGTERM");
  };
}

// Single quick probe of the target
export async function isHttpReady(url: string): Promise<boolean> {
  try {
    const res = await axios.get(url, { timeout: 2000 });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

// Wait for service to be reachable
export async function waitForHttpReady(
  url: string,
  timeoutMs: number = 30000,
  interval: number = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHttpReady(url)) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout: ${url} did not become ready`);
}

export async function bringUpService(composeDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = "docker compose up -d";

    exec(cmd, { cwd: composeDir, env: process.env }, (err: Error | null, stdout: string, stderr: string) => {
      if (!err) {
        return resolve(stdout);
      }

      // Check if /bin/sh is available
      if (!fs.existsSync("/bin/sh")) {
        console.error("/bin/sh does not exist or is not accessible");
      }

      // Check if compose directory exists
      if (!fs.existsSync(composeDir)) {
        console.error(`Compose directory does not exist: ${composeDir}`);
      } else {
        // Check for compose file with various naming conventions
        const composeFiles = [
          "docker-compose.yml",
          "docker-compose.yaml",
          "compose.yml",
          "compose.yaml"
        ];
        const foundFile = composeFiles.find(f => fs.existsSync(path.join(composeDir, f)));
        if (!foundFile) {
          console.error(`Missing compose file in ${composeDir}. Expected one of: ${composeFiles.join(", ")}`);
        }
      }

      console.error(stderr);

      // Check for container name conflict
      const match = stderr.match(/container name "(.+?)" is already in use/);
      if (match) {
        const containerName = match[1];
        console.warn(`Container conflict detected: ${containerName}. Attempting to remove...`);

        // Remove the conflicting container
        exec(`docker rm -f ${containerName}`, { env: process.env }, (rmErr: Error | null, rmOut: string, rmStderr: string) => {
          if (rmErr) {
            console.error(`Failed to remove conflicting container: ${rmStderr}`);
            return reject(rmErr);
          }

          console.log(`Removed ${containerName}. Retrying docker compose...`);

          // Retry docker compose
          exec(cmd, { cwd: composeDir, env: process.env }, (retryErr: Error | null, retryOut: string, retryStderr: string) => {
            if (retryErr) {
              console.error(`Retry failed: ${retryStderr}`);
              return reject(retryErr);
            }

            resolve(retryOut);
          });
        });
      } else {
        reject(err);
      }
    });
  });
}
