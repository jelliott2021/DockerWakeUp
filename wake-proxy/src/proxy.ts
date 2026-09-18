/**
 * Per-service HTTP + WebSocket proxying, and the "backend is down" path that
 * turns a failed proxy attempt into a wake-up.
 */
import type { Request, Response } from "express";
import { createProxyMiddleware, type Options, type RequestHandler } from "http-proxy-middleware";
import type http from "http";
import type net from "net";
import { type Config, type ServiceConfig } from "./config";
import { touchLastAccess } from "./lastAccess";
import { triggerWake, waitForReady } from "./wakeManager";
import { renderWakePage } from "./wakePage";

/** How long a safe (GET/HEAD) non-browser request waits for a waking service. */
export const RETRY_WAIT_MS = 60_000;

export type ProxyMiddleware = RequestHandler;

/** Preserve the original hostname/scheme so apps get proper CORS/CSRF/redirect behaviour. */
function forwardOriginalHost(proxyReq: http.ClientRequest, req: http.IncomingMessage): void {
  const host = req.headers["x-forwarded-host"];
  if (host) {
    proxyReq.setHeader("X-Forwarded-Host", host);
    proxyReq.setHeader("Host", host);
  }
  const proto = req.headers["x-forwarded-proto"];
  if (proto) proxyReq.setHeader("X-Forwarded-Proto", proto);
}

function baseOptions(route: string, svc: ServiceConfig): Options {
  return {
    target: svc.target,
    changeOrigin: true,
    // Resolve the console when logging (the default captures its methods at
    // startup, which bypasses anything that wraps console later, e.g. tests)
    logProvider: () => console,
    // Only strips the prefix when it is actually there, so host-routed
    // (unprefixed) paths pass through unchanged
    pathRewrite: { [`^/proxy/${route}`]: "" },
    onProxyReq: (proxyReq, req) => forwardOriginalHost(proxyReq, req),
    // WebSocket upgrades fire a separate event and don't go through onProxyReq
    onProxyReqWs: (proxyReq, req) => forwardOriginalHost(proxyReq, req),
  };
}

/**
 * The proxy middleware for one HTTP service. Successful responses and
 * WebSocket handshakes count as activity for idle shutdown; a failed attempt
 * (backend down) goes to `handleProxyError`.
 */
export function createServiceProxy(
  route: string,
  svc: ServiceConfig,
  config: Config,
): ProxyMiddleware {
  // Used to replay a request once the service is up. Built without the
  // handlers below so a second failure ends in http-proxy-middleware's own
  // error response instead of another wake cycle.
  let retryProxy: ProxyMiddleware | undefined;
  const getRetryProxy = () => (retryProxy ??= createProxyMiddleware(baseOptions(route, svc)));

  return createProxyMiddleware({
    ...baseOptions(route, svc),
    onProxyRes: (proxyRes) => {
      if (countsAsActivity(proxyRes.statusCode)) touchLastAccess(route);
    },
    // A successful WebSocket handshake is activity too — without this, an app
    // that talks only over a WebSocket after its page load looks idle
    onOpen: () => touchLastAccess(route),
    onError: (_err, req, res) => {
      void handleProxyError(route, svc, config, req, res, getRetryProxy());
    },
  });
}

/**
 * What happens when the backend does not answer: wake the service, then
 * - browser navigations get the wake page right away (503),
 * - non-idempotent requests get an immediate 503 + Retry-After (their body
 *   was already consumed by the failed attempt, so they cannot be replayed),
 * - safe requests (API/asset GETs) wait for the service and are replayed once.
 * Failed WebSocket upgrades hand over a raw socket instead of a response; it
 * is closed so the client's reconnect logic retries once the service is up.
 */
export async function handleProxyError(
  route: string,
  svc: ServiceConfig,
  config: Config,
  req: Request,
  res: Response | net.Socket,
  retryProxy: ProxyMiddleware,
): Promise<void> {
  console.warn(`Proxy to ${route} failed, waking service...`);
  // Fire-and-forget; deduped inside the wake manager
  void triggerWake(route, svc);

  if (!isServerResponse(res)) {
    res.on("error", () => {});
    res.destroy();
    return;
  }

  const method = (req.method ?? "").toUpperCase();
  const wantsHtml = method === "GET" && String(req.headers.accept ?? "").includes("text/html");

  if (wantsHtml) {
    if (!res.headersSent) {
      res.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      });
      res.end(renderWakePage(route, svc.wakePage ?? config.wakePage));
    }
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    respondStarting(res, "15", `${route} is starting up. Retry shortly.`);
    return;
  }

  try {
    await waitForReady(svc, RETRY_WAIT_MS);
    retryProxy(req, res, () => {});
  } catch (e) {
    console.error(`Failed to recover service ${route}:`, e);
    respondStarting(res, "5", `${route} is starting up. Try again shortly.`);
  }
}

/** Successful and redirect responses reset the idle timer; errors do not. */
export function countsAsActivity(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 200 && statusCode < 400;
}

function isServerResponse(res: Response | net.Socket): res is Response {
  return typeof (res as Response).writeHead === "function";
}

function respondStarting(res: Response, retryAfter: string, message: string): void {
  if (res.headersSent) return;
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": retryAfter });
  res.end(JSON.stringify({ error: message }));
}
