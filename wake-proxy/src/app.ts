/**
 * The Express application: health check, wake endpoints and the per-service
 * proxies. Pure wiring — nothing listens and no timers start here — so it can
 * be exercised in-process with supertest.
 */
import express from "express";
import type http from "http";
import type net from "net";
import type { Duplex } from "stream";

import { type Config, type ServiceMap } from "./config";
import { createHostRouter, type HostRouter } from "./routing";
import { createServiceProxy, type ProxyMiddleware } from "./proxy";
import { getUpdateInfo } from "./updateChecker";
import { sendWakeStatus, streamWakeLogs } from "./wakeEndpoints";

export interface WakeProxyApp {
  app: express.Express;
  router: HostRouter;
  /** One proxy middleware per HTTP service, keyed by route */
  proxies: Record<string, ProxyMiddleware>;
  /**
   * `upgrade` listener for the HTTP server. Upgrades never pass through
   * Express, so the route is resolved here — `/proxy/<route>` first, then the
   * hostname, mirroring the middleware order — and exactly one service proxy
   * gets the socket. Anything unmatched is closed rather than left hanging.
   */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** Build the application for a validated set of services. */
export function createApp(config: Config, services: ServiceMap): WakeProxyApp {
  const app = express();
  const router = createHostRouter(services, config.domain);
  const proxies: Record<string, ProxyMiddleware> = {};

  // Liveness probe (used by the docker-compose healthcheck). On a hostname
  // that belongs to a service, fall through so the service's own /healthz is
  // proxied. Full detail (commit hashes, service count) only goes to direct
  // local checks — not to whatever hostname a public reverse proxy failed to
  // match.
  app.get("/healthz", (req, res, next) => {
    if (router.routeForHost(req)) return next();
    if (!isLocalRequest(req)) {
      res.json({ ok: true });
      return;
    }
    res.json({ ok: true, services: Object.keys(services).length, update: getUpdateInfo() });
  });

  // Wake endpoints — registered BEFORE the proxies so they are never forwarded.
  // Path-prefixed form (direct access / legacy reverse proxy configs):
  app.get("/proxy/:route/__wake/status", (req, res) => {
    const svc = services[req.params.route];
    if (!svc) {
      res.status(404).json({ error: "unknown service" });
      return;
    }
    void sendWakeStatus(svc, res);
  });
  app.get("/proxy/:route/__wake/logs", (req, res) => {
    const svc = services[req.params.route];
    if (!svc) {
      res.sendStatus(404);
      return;
    }
    streamWakeLogs(svc, req, res);
  });
  // Host-resolved form (reverse proxies that just forward the request):
  app.get("/__wake/status", (req, res, next) => {
    const route = router.routeForHost(req);
    if (!route) return next();
    void sendWakeStatus(services[route], res);
  });
  app.get("/__wake/logs", (req, res, next) => {
    const route = router.routeForHost(req);
    if (!route) return next();
    streamWakeLogs(services[route], req, res);
  });

  for (const [route, svc] of Object.entries(services)) {
    if (svc.type === "tcp") continue; // TCP services have their own listener
    proxies[route] = createServiceProxy(route, svc, config);
    app.use(`/proxy/${route}`, proxies[route]);
  }

  // Host-routed requests reuse the same per-service middleware
  app.use((req, res, next) => {
    const route = router.routeForHost(req);
    if (!route) return next();
    proxies[route](req, res, next);
  });

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => {}); // a client vanishing mid-handshake is not our problem
    const route = router.routeForUpgrade(req, (r) => r in proxies);
    if (!route) {
      socket.destroy();
      return;
    }
    // Wake logic is shared with HTTP: a sleeping backend errors in onError,
    // which triggers the wake and closes the socket for the client to retry
    // Node types the upgraded stream as a Duplex; for an HTTP server it is a net.Socket
    proxies[route].upgrade?.(req as express.Request, socket as net.Socket, head);
  }

  return { app, router, proxies, handleUpgrade };
}

/** `true` for a request from loopback that did not pass through a reverse proxy. */
export function isLocalRequest(req: express.Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return (
    !req.headers["x-forwarded-for"] &&
    (addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127."))
  );
}
