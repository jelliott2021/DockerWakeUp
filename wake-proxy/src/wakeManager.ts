import { exec, spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import axios from "axios";
import { touchLastAccess, recordWakeDuration, getWakeDurations } from "./lastAccess";

export type WakeState = "idle" | "starting" | "ready" | "failed";

export interface WakeStatus {
  state: WakeState;
  startedAt?: number;
  error?: string;
}

/** The parts of a service config the wake manager needs */
export interface WakeTarget {
  target: string;
  composeDir?: string;
  type?: "http" | "tcp";
  /** Pre-start hook run before `docker compose up -d` (or the whole start when there's no composeDir) */
  startCommand?: string;
}

const statuses: Record<string, WakeStatus> = {};

// Don't retry a failed wake-up for this long
const FAILED_RETRY_MS = 15_000;

export function getWakeStatus(route: string): WakeStatus {
  return statuses[route] ?? { state: "idle" };
}

/** Median of recorded wake durations, or null with no history yet */
export function getExpectedWakeMs(route: string): number | null {
  const durations = getWakeDurations(route);
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Kick off a wake-up for a service (fire-and-forget).
 * Deduped: if a wake-up is already in progress, or one just failed, this is a no-op.
 */
export function triggerWake(route: string, svc: WakeTarget, timeoutMs: number = 120_000): void {
  const current = statuses[route];
  if (current?.state === "starting") return;
  if (current?.state === "failed" && Date.now() - (current.startedAt ?? 0) < FAILED_RETRY_MS) return;

  const fail = (msg: string) => {
    statuses[route] = { state: "failed", startedAt: Date.now(), error: msg };
    console.error(`Failed to wake service ${route}: ${msg}`);
  };

  if (!svc.composeDir && !svc.startCommand) {
    return fail(`Service has no composeDir and no startCommand — nothing to run. Check config.json`);
  }
  // A missing cwd makes spawn fail with a misleading "spawn /bin/sh ENOENT"
  if (svc.composeDir && !fs.existsSync(svc.composeDir)) {
    return fail(`Compose directory not found: ${svc.composeDir} — check this service's composeDir in config.json`);
  }

  const startedAt = Date.now();
  statuses[route] = { state: "starting", startedAt };

  (async () => {
    try {
      // startCommand is a pre-start hook run before `docker compose up -d`
      // (or the whole start when there's no composeDir). A failing hook is
      // logged but doesn't abort the wake — the readiness check below is
      // the source of truth.
      if (svc.startCommand) {
        try {
          await runStartCommand(svc.startCommand, svc.composeDir, false);
        } catch (e: any) {
          if (!svc.composeDir) throw e;
          console.error(`startCommand for ${route} failed (continuing):`, e?.message ?? e);
        }
      }
      if (svc.composeDir) {
        await runStartCommand("docker compose up -d", svc.composeDir, true);
      }
      await waitForReady(svc, timeoutMs);
      statuses[route] = { state: "ready", startedAt };
      recordWakeDuration(route, Date.now() - startedAt);
      // Refresh the idle timestamp so the idle checker doesn't stop the
      // service before the first request is proxied successfully
      touchLastAccess(route);
      console.log(`Service ${route} is ready (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      statuses[route] = { state: "failed", startedAt: Date.now(), error: e?.message ?? String(e) };
      console.error(`Failed to wake service ${route}:`, e);
    }
  })();
}

/**
 * Stream startup logs for a service, line by line: a custom logsCommand if
 * configured, otherwise `docker compose logs -f` in its compose directory.
 * Returns a function that stops the stream.
 */
export function streamServiceLogs(
  svc: { composeDir?: string; logsCommand?: string },
  onLine: (line: string) => void,
  tail: number = 50
): () => void {
  let child;
  if (svc.logsCommand) {
    child = spawn("/bin/sh", ["-c", svc.logsCommand], {
      cwd: svc.composeDir && fs.existsSync(svc.composeDir) ? svc.composeDir : undefined,
      env: process.env,
    });
  } else if (!svc.composeDir) {
    onLine("[wake-proxy] no logs available (service has no composeDir or logsCommand)");
    return () => { };
  } else if (!fs.existsSync(svc.composeDir)) {
    onLine(`[wake-proxy] compose directory not found: ${svc.composeDir}`);
    return () => { };
  } else {
    child = spawn(
      "docker",
      ["compose", "logs", "-f", "--no-color", "--tail", String(tail)],
      { cwd: svc.composeDir, env: process.env }
    );
  }

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
  child.on("error", (err: Error) => onLine(`[wake-proxy] failed to stream logs: ${err.message}`));

  return () => {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.kill("SIGTERM");
  };
}

/** Parse "host:port", "tcp://host:port", or "http://host:port" into parts */
export function parseHostPort(target: string): { host: string; port: number } {
  const cleaned = target.replace(/^(tcp|https?):\/\//, "").replace(/\/.*$/, "");
  const [host, portStr] = cleaned.split(":");
  return { host: host || "localhost", port: parseInt(portStr, 10) };
}

/** Single quick probe of a service's target, HTTP or TCP */
export async function isServiceReady(svc: { target: string; type?: string }): Promise<boolean> {
  if (svc.type === "tcp") {
    const { host, port } = parseHostPort(svc.target);
    return isTcpReady(host, port);
  }
  return isHttpReady(svc.target);
}

export async function isHttpReady(url: string): Promise<boolean> {
  try {
    const res = await axios.get(url, { timeout: 2000 });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

export function isTcpReady(host: string, port: number, timeoutMs: number = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Wait for a service to be reachable (HTTP or TCP depending on its type) */
export async function waitForReady(
  svc: { target: string; type?: string },
  timeoutMs: number = 30000,
  interval: number = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServiceReady(svc)) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout: ${svc.target} did not become ready`);
}

function runStartCommand(cmd: string, cwd: string | undefined, composeRecovery: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, env: process.env }, (err: Error | null, stdout: string, stderr: string) => {
      if (!err) {
        return resolve(stdout);
      }

      // Check if /bin/sh is available
      if (!fs.existsSync("/bin/sh")) {
        console.error("/bin/sh does not exist or is not accessible");
      }

      if (composeRecovery && cwd) {
        // Check for compose file with various naming conventions
        const composeFiles = [
          "docker-compose.yml",
          "docker-compose.yaml",
          "compose.yml",
          "compose.yaml"
        ];
        const foundFile = composeFiles.find(f => fs.existsSync(path.join(cwd, f)));
        if (!foundFile) {
          console.error(`Missing compose file in ${cwd}. Expected one of: ${composeFiles.join(", ")}`);
        }
      }

      console.error(stderr);

      // Check for container name conflict (docker compose only)
      const match = composeRecovery ? stderr.match(/container name "(.+?)" is already in use/) : null;
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
          exec(cmd, { cwd, env: process.env }, (retryErr: Error | null, retryOut: string, retryStderr: string) => {
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
