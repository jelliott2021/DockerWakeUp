/**
 * The two endpoints the wake page uses: a JSON readiness poll and a
 * Server-Sent Events stream of the service's startup logs.
 */
import type express from "express";
import { type ServiceConfig } from "./config";
import { getExpectedWakeMs, getWakeStatus, isServiceReady, streamServiceLogs } from "./wakeManager";

/** Keep intermediaries from closing an otherwise-quiet SSE connection. */
export const SSE_PING_INTERVAL_MS = 15_000;

/** `GET __wake/status` — the readiness poll. */
export async function sendWakeStatus(svc: ServiceConfig, res: express.Response): Promise<void> {
  const status = getWakeStatus(svc.route);
  const ready = await isServiceReady(svc);
  res.json({
    state: status.state,
    ready,
    startedAt: status.startedAt,
    error: status.error,
    // For the "usually ready in ~Xs" progress estimate
    expectedMs: getExpectedWakeMs(svc.route),
    elapsedMs:
      status.state === "starting" && status.startedAt ? Date.now() - status.startedAt : null,
  });
}

/**
 * `GET __wake/logs` — live startup logs as Server-Sent Events, one
 * JSON-encoded line per event.
 *
 * Streaming is limited to an active (or just-failed) wake of a service that
 * opted in with `showLogs`: otherwise this would be a public live tap into
 * any running service's logs, and `--tail` would expose the previous run's
 * logs for sleeping ones. In every other case a single notice is sent.
 */
export function streamWakeLogs(
  svc: ServiceConfig,
  req: express.Request,
  res: express.Response,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering for this response
  });
  res.write("retry: 3000\n\n");

  const send = (line: string) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  const state = getWakeStatus(svc.route).state;
  let stopLogs = () => {};
  if (svc.showLogs !== true) {
    send(
      '[wake-proxy] log streaming is disabled for this service (set "showLogs": true in config.json to enable)',
    );
  } else if (state !== "starting" && state !== "failed") {
    send("[wake-proxy] log streaming is only available while the service is starting");
  } else {
    stopLogs = streamServiceLogs(svc, send);
  }

  const ping = setInterval(() => res.write(": ping\n\n"), SSE_PING_INTERVAL_MS);
  req.on("close", () => {
    clearInterval(ping);
    stopLogs();
  });
}
