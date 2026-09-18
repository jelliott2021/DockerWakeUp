/**
 * Wake orchestration: starting services, readiness probes and startup-log
 * streaming. Wake state is kept in memory per route.
 */
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import axios from "axios";
import { touchLastAccess, recordWakeDuration, getWakeDurations } from "./lastAccess";
import { CommandError, runFile, runShell } from "./shell";
import { errorMessage, sleep } from "./util";

export type WakeState = "idle" | "starting" | "ready" | "failed";

export interface WakeStatus {
  state: WakeState;
  /** When the wake began — or, for `failed`, when it failed */
  startedAt?: number;
  error?: string;
}

/** The parts of a service config the wake manager needs. */
export interface WakeTarget {
  target: string;
  composeDir?: string;
  type?: "http" | "tcp";
  /** Pre-start hook run before `docker compose up -d`, or the whole start when there is no composeDir */
  startCommand?: string;
}

/** The parts of a service config log streaming needs. */
export interface LogSource {
  composeDir?: string;
  logsCommand?: string;
}

/** Don't retry a failed wake-up for this long. */
export const FAILED_RETRY_MS = 15_000;
/** Give up on a wake after this long without the target answering. */
export const DEFAULT_WAKE_TIMEOUT_MS = 120_000;
/** Number of log lines to replay when the log stream starts. */
export const DEFAULT_LOG_TAIL = 50;

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const COMPOSE_UP = "docker compose up -d";
const CONTAINER_CONFLICT_RE = /container name "(.+?)" is already in use/;

/** Every recorded status carries its timestamp; only the implicit `idle` state has none. */
interface RecordedWakeStatus extends WakeStatus {
  startedAt: number;
}

const statuses: Record<string, RecordedWakeStatus> = {};

/** Current wake state of a service (`idle` when it has never been woken). */
export function getWakeStatus(route: string): WakeStatus {
  return statuses[route] ?? { state: "idle" };
}

/** Forget every wake state (tests). */
export function resetWakeStatuses(): void {
  for (const route of Object.keys(statuses)) delete statuses[route];
}

/** Median of recorded wake durations, or `null` with no history yet. */
export function getExpectedWakeMs(route: string): number | null {
  const durations = getWakeDurations(route);
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Kick off a wake-up for a service. Deduped: a no-op while a wake is already
 * in progress or shortly after one failed. The returned promise settles when
 * the background work is done (callers normally fire-and-forget; tests await).
 */
export function triggerWake(
  route: string,
  svc: WakeTarget,
  timeoutMs: number = DEFAULT_WAKE_TIMEOUT_MS,
): Promise<void> {
  const current = statuses[route];
  if (current?.state === "starting") return Promise.resolve();
  if (current?.state === "failed" && Date.now() - current.startedAt < FAILED_RETRY_MS) {
    return Promise.resolve();
  }

  if (!svc.composeDir && !svc.startCommand) {
    return failEarly(
      route,
      "Service has no composeDir and no startCommand — nothing to run. Check config.json",
    );
  }
  // A missing cwd makes spawn fail with a misleading "spawn /bin/sh ENOENT"
  if (svc.composeDir && !fs.existsSync(svc.composeDir)) {
    return failEarly(
      route,
      `Compose directory not found: ${svc.composeDir} — check this service's composeDir in config.json`,
    );
  }

  const startedAt = Date.now();
  statuses[route] = { state: "starting", startedAt };
  return wake(route, svc, startedAt, timeoutMs);
}

function failEarly(route: string, message: string): Promise<void> {
  statuses[route] = { state: "failed", startedAt: Date.now(), error: message };
  console.error(`Failed to wake service ${route}: ${message}`);
  return Promise.resolve();
}

async function wake(
  route: string,
  svc: WakeTarget,
  startedAt: number,
  timeoutMs: number,
): Promise<void> {
  try {
    if (svc.startCommand) {
      // A failing hook is logged but doesn't abort a compose-managed wake —
      // the readiness check below is the source of truth. Without a
      // composeDir the hook *is* the start, so its failure is the wake's.
      try {
        await runHook(svc.startCommand, svc.composeDir);
      } catch (e) {
        if (!svc.composeDir) throw e;
        console.error(`startCommand for ${route} failed (continuing):`, errorMessage(e));
      }
    }
    if (svc.composeDir) await composeUp(svc.composeDir);
    await waitForReady(svc, timeoutMs);
    statuses[route] = { state: "ready", startedAt };
    recordWakeDuration(route, Date.now() - startedAt);
    // Refresh the idle timestamp so the idle checker doesn't stop the
    // service before the first request is proxied successfully
    touchLastAccess(route);
    console.log(`Service ${route} is ready (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  } catch (e) {
    statuses[route] = { state: "failed", startedAt: Date.now(), error: errorMessage(e) };
    console.error(`Failed to wake service ${route}:`, e);
  }
}

/** Run a user hook, surfacing its stderr in the log when it fails. */
async function runHook(command: string, cwd: string | undefined): Promise<void> {
  try {
    await runShell(command, cwd);
  } catch (e) {
    if (e instanceof CommandError) console.error(e.stderr);
    throw e;
  }
}

/**
 * `docker compose up -d` in `cwd`, recovering once from the "container name
 * already in use" conflict left behind by a crashed or renamed stack.
 */
async function composeUp(cwd: string): Promise<void> {
  try {
    await runShell(COMPOSE_UP, cwd);
    return;
  } catch (e) {
    if (!(e instanceof CommandError)) throw e;
    if (!COMPOSE_FILES.some((file) => fs.existsSync(path.join(cwd, file)))) {
      console.error(`Missing compose file in ${cwd}. Expected one of: ${COMPOSE_FILES.join(", ")}`);
    }
    console.error(e.stderr);
    const conflict = CONTAINER_CONFLICT_RE.exec(e.stderr);
    if (!conflict) throw e;
    await removeConflictingContainer(conflict[1]);
  }
  try {
    await runShell(COMPOSE_UP, cwd);
  } catch (e) {
    console.error(`Retry failed: ${e instanceof CommandError ? e.stderr : errorMessage(e)}`);
    throw e;
  }
}

async function removeConflictingContainer(containerName: string): Promise<void> {
  console.warn(`Container conflict detected: ${containerName}. Attempting to remove...`);
  try {
    // The name comes from parsed docker stderr — runFile passes it as an
    // argument, never through a shell
    await runFile("docker", ["rm", "-f", containerName]);
  } catch (e) {
    console.error(
      `Failed to remove conflicting container: ${e instanceof CommandError ? e.stderr : errorMessage(e)}`,
    );
    throw e;
  }
  console.log(`Removed ${containerName}. Retrying docker compose...`);
}

/**
 * Stream startup logs for a service line by line: a custom `logsCommand` if
 * configured, otherwise `docker compose logs -f` in its compose directory.
 * Returns a function that stops the stream.
 */
export function streamServiceLogs(
  svc: LogSource,
  onLine: (line: string) => void,
  tail: number = DEFAULT_LOG_TAIL,
): () => void {
  const composeDirExists = svc.composeDir !== undefined && fs.existsSync(svc.composeDir);
  let child;
  if (svc.logsCommand) {
    // Own process group, so stopping the stream also ends whatever the shell
    // started (`tail -f`, a pipeline) instead of orphaning it
    child = spawn("/bin/sh", ["-c", svc.logsCommand], {
      cwd: composeDirExists ? svc.composeDir : undefined,
      detached: true,
    });
  } else if (!svc.composeDir) {
    onLine("[wake-proxy] no logs available (service has no composeDir or logsCommand)");
    return () => {};
  } else if (!composeDirExists) {
    onLine(`[wake-proxy] compose directory not found: ${svc.composeDir}`);
    return () => {};
  } else {
    child = spawn("docker", ["compose", "logs", "-f", "--no-color", "--tail", String(tail)], {
      cwd: svc.composeDir,
    });
  }

  let buffer = "";
  const handleChunk = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() as string; // split() always yields at least one element
    for (const line of lines) {
      if (line.trim().length > 0) onLine(line);
    }
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("error", (err: Error) => onLine(`[wake-proxy] failed to stream logs: ${err.message}`));

  const stop = () => {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    if (svc.logsCommand && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM"); // the whole process group
        return;
      } catch {
        // already gone, or not a group leader — fall back to the child itself
      }
    }
    child.kill("SIGTERM");
  };
  return stop;
}

/** Parse `host:port`, `tcp://host:port` or `http://host:port` into its parts. */
export function parseHostPort(target: string): { host: string; port: number } {
  const cleaned = target.replace(/^(tcp|https?):\/\//, "").replace(/\/.*$/, "");
  const [host, portStr] = cleaned.split(":");
  return { host: host || "localhost", port: parseInt(portStr, 10) };
}

/** Single quick probe of a service's target, HTTP or TCP depending on its type. */
export async function isServiceReady(svc: { target: string; type?: string }): Promise<boolean> {
  if (svc.type === "tcp") {
    const { host, port } = parseHostPort(svc.target);
    return isTcpReady(host, port);
  }
  return isHttpReady(svc.target);
}

/** `true` when the URL answers with anything but a server error (auth pages count as up). */
export async function isHttpReady(url: string, timeoutMs: number = 2000): Promise<boolean> {
  try {
    const res = await axios.get(url, { timeout: timeoutMs, validateStatus: () => true });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

/** `true` when a TCP connection to host:port succeeds within the timeout. */
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

/** Poll until the service is reachable; rejects after `timeoutMs`. */
export async function waitForReady(
  svc: { target: string; type?: string },
  timeoutMs: number = 30_000,
  intervalMs: number = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServiceReady(svc)) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout: ${svc.target} did not become ready`);
}
